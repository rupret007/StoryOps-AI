import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { asDecimalString, asDomainId, asISODateTime, money } from '../../../src/domain/index.ts';
import { calculateEstimate, type PricingResult } from '../../../src/core/pricing/index.ts';
import { sha256Hex } from '../../../src/core/ai/approval.ts';
import { consumeOperationBudget } from '../../../src/core/integrations/operationBudget.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import { loadActivePriceBook } from '../_shared/server-pricing-tool.ts';
import {
  estimateWorkflowRequestSchema,
  persistedEstimateReceiptSchema,
  type EstimateCalculateRequest,
} from './contracts.ts';
import { measurementSupportsScope } from './evidence.ts';

type Row = Record<string, unknown>;
type MembershipRole = 'owner' | 'dispatcher';

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new HttpError(`Server configuration ${name} is missing.`, 503, 'MISCONFIGURED');
  return value;
}

function rowText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  throw new HttpError(`Authoritative record is missing ${key}.`, 503, 'AUTHORITATIVE_DATA_INVALID');
}

function objectValue(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(
      `${label} returned an invalid response.`,
      503,
      'AUTHORITATIVE_DATA_INVALID',
    );
  }
  return value as Row;
}

function rowArray(value: unknown, label: string): Row[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object')) {
    throw new HttpError(
      `${label} returned an invalid response.`,
      503,
      'AUTHORITATIVE_DATA_INVALID',
    );
  }
  return value as Row[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

async function authenticate(
  client: SupabaseClient,
  authorization: string | null,
  companyId: string,
): Promise<{ userId: string; role: MembershipRole }> {
  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
  }
  const {
    data: { user },
    error: authError,
  } = await client.auth.getUser(authorization.slice('Bearer '.length));
  if (authError || !user) {
    throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
  }
  const { data, error } = await client.rpc('resolve_estimate_actor', {
    p_company_id: companyId,
    p_actor_user_id: user.id,
  });
  if (error) {
    const forbidden = /BACKOFFICE_ROLE_REQUIRED/iu.test(error.message);
    throw new HttpError(
      forbidden
        ? 'Only active back-office staff may price estimates.'
        : 'Company membership and status could not be verified.',
      forbidden ? 403 : 503,
      forbidden ? 'ROLE_FORBIDDEN' : 'MEMBERSHIP_UNAVAILABLE',
    );
  }
  const actor = objectValue(data, 'Estimate actor snapshot');
  if (actor.role !== 'owner' && actor.role !== 'dispatcher') {
    throw new HttpError('Only back-office staff may price estimates.', 403, 'ROLE_FORBIDDEN');
  }
  return { userId: user.id, role: actor.role };
}

async function consumeEstimateBudget(
  client: SupabaseClient,
  companyId: string,
  userId: string,
  operation: 'context' | 'calculate',
): Promise<void> {
  const budget = await consumeOperationBudget({
    client,
    companyId,
    scope: `estimate-workflow:${operation}:user:hour`,
    subject: userId,
    limit: operation === 'context' ? 120 : 30,
    windowSeconds: 3_600,
  });
  if (!budget.allowed) {
    throw new HttpError(
      `Estimate ${operation} limit reached; retry after ${budget.reset_at}.`,
      429,
      'RATE_LIMITED',
    );
  }
}

async function loadActiveBook(client: SupabaseClient, companyId: string) {
  try {
    return await loadActivePriceBook(client, companyId);
  } catch {
    throw new HttpError(
      'The active price book could not be loaded.',
      409,
      'NO_EFFECTIVE_PRICE_BOOK',
    );
  }
}

function postalCodeFromAddress(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError('Property service address is invalid.', 503, 'PROPERTY_ADDRESS_INVALID');
  }
  const address = value as Row;
  const postalCode =
    typeof address.postalCode === 'string'
      ? address.postalCode
      : typeof address.postal_code === 'string'
        ? address.postal_code
        : '';
  if (!/^[0-9]{5}(?:-[0-9]{4})?$/u.test(postalCode)) {
    throw new HttpError(
      'A normalized US postal code is required to derive the travel zone.',
      422,
      'POSTAL_CODE_REQUIRED',
    );
  }
  return postalCode.slice(0, 5);
}

function deriveTravelZone(
  priceBook: Awaited<ReturnType<typeof loadActiveBook>>,
  serviceAddress: unknown,
): { code: string; source: 'postal_code' | 'conservative_default'; postalCode: string } {
  const postalCode = postalCodeFromAddress(serviceAddress);
  const exact = priceBook.travelZones.find((zone) => zone.postalCodes?.includes(postalCode));
  if (exact) return { code: exact.zoneCode, source: 'postal_code', postalCode };
  const conservative = [...priceBook.travelZones]
    .filter((zone) => (zone.postalCodes?.length ?? 0) === 0)
    .sort((left, right) => Number(right.fee.amount) - Number(left.fee.amount))[0];
  if (!conservative) {
    throw new HttpError(
      'The property postal code is outside configured travel-zone evidence.',
      422,
      'TRAVEL_ZONE_UNRESOLVED',
    );
  }
  return {
    code: conservative.zoneCode,
    source: 'conservative_default',
    postalCode,
  };
}

async function estimateContext(
  client: SupabaseClient,
  companyId: string,
  actorUserId: string,
  propertyId?: string,
): Promise<Record<string, unknown>> {
  const [snapshotResult, priceBook] = await Promise.all([
    client.rpc('load_estimate_context_snapshot', {
      p_company_id: companyId,
      p_actor_user_id: actorUserId,
      p_property_id: propertyId ?? null,
    }),
    loadActiveBook(client, companyId),
  ]);
  if (snapshotResult.error) {
    const propertyMissing = /ESTIMATE_PROPERTY_NOT_FOUND/iu.test(snapshotResult.error.message);
    const termsMissing = /ESTIMATE_APPROVED_TERMS_REQUIRED/iu.test(snapshotResult.error.message);
    throw new HttpError(
      propertyMissing
        ? 'The requested property is not company-owned.'
        : termsMissing
          ? 'A legally reviewed, effective service-terms version is required before quoting.'
          : 'Customer and property context could not be loaded.',
      propertyMissing ? 404 : termsMissing ? 409 : 503,
      propertyMissing
        ? 'PROPERTY_NOT_FOUND'
        : termsMissing
          ? 'APPROVED_TERMS_REQUIRED'
          : 'ESTIMATE_CONTEXT_UNAVAILABLE',
    );
  }
  const snapshot = objectValue(snapshotResult.data, 'Estimate context snapshot');
  const customers = rowArray(snapshot.customers, 'Estimate customers');
  const properties = rowArray(snapshot.properties, 'Estimate properties');
  const contextMeasurements = rowArray(snapshot.measurements, 'Estimate measurements');
  const serviceTerms = objectValue(snapshot.service_terms, 'Approved service terms');
  const photoEvidence =
    snapshot.photo_evidence === null || snapshot.photo_evidence === undefined
      ? null
      : objectValue(snapshot.photo_evidence, 'Photo evidence');
  const selectedPropertyId =
    propertyId ?? (properties[0] ? rowText(properties[0], 'id') : undefined);
  const selectedProperty = properties.find((property) => property.id === selectedPropertyId);
  const travelZone = selectedProperty
    ? deriveTravelZone(priceBook, selectedProperty.service_address)
    : null;
  return {
    operation: 'context',
    companyId,
    customers: customers.map((customer) => ({
      id: customer.id,
      displayName: customer.display_name,
      taxExempt: customer.tax_exempt === true,
    })),
    properties: properties.map((property) => ({
      id: property.id,
      customerId: property.customer_id,
      name: property.name,
      serviceAddress: property.service_address,
      stories: property.stories,
    })),
    measurements: contextMeasurements.map((measurement) => ({
      id: rowText(measurement, 'id'),
      propertyId: rowText(measurement, 'property_id'),
      kind: rowText(measurement, 'kind'),
      label: rowText(measurement, 'label'),
      value: rowText(measurement, 'value'),
      unit: rowText(measurement, 'unit'),
      source: rowText(measurement, 'source'),
      measuredAt: rowText(measurement, 'measured_at'),
      confidence:
        measurement.confidence === null || measurement.confidence === undefined
          ? null
          : String(measurement.confidence),
      verifiedByHuman: measurement.verified_by_human === true,
      serviceCodes: stringArray(measurement.service_codes),
      addOnCodes: stringArray(measurement.add_on_codes),
    })),
    photoEvidence: photoEvidence
      ? {
          id: photoEvidence.id,
          confidence: String(photoEvidence.overall_confidence),
          unknowns: photoEvidence.unknowns,
          disposition: photoEvidence.disposition,
          analyzedAt: photoEvidence.analyzed_at,
          injectionSignals: photoEvidence.injection_signals,
        }
      : null,
    priceBook,
    serviceTerms: {
      id: rowText(serviceTerms, 'id'),
      versionLabel: rowText(serviceTerms, 'version_label'),
      reviewReference: rowText(serviceTerms, 'review_reference'),
      reviewedAt: rowText(serviceTerms, 'reviewed_at'),
    },
    derivedTravelZone: travelZone,
  };
}

function requiredStoriesValue(stories: unknown): string {
  if (stories === 1) return 'one';
  if (stories === 2) return 'two';
  if (stories === 3) return 'three';
  throw new HttpError(
    'A one-, two-, or three-story property record is required by this price book.',
    422,
    'STORIES_OUTSIDE_PRICE_BOOK',
  );
}

function assertMeasurementForScope(
  measurement: Row,
  pricingUnit: string,
  serviceCode: string,
  addOnCode?: string,
): void {
  if (!measurementSupportsScope(measurement, pricingUnit, serviceCode, addOnCode)) {
    throw new HttpError(
      `Measurement ${rowText(measurement, 'id')} is not classified for ${
        addOnCode ? `add-on ${addOnCode}` : `service ${serviceCode}`
      } with pricing unit ${pricingUnit}.`,
      422,
      'MEASUREMENT_SCOPE_MISMATCH',
    );
  }
}

async function calculateAndPersist(
  client: SupabaseClient,
  request: EstimateCalculateRequest,
  actor: { userId: string; role: MembershipRole },
): Promise<Record<string, unknown>> {
  const intentHash = await sha256Hex({
    operation: request.operation,
    companyId: request.companyId,
    customerId: request.customerId,
    propertyId: request.propertyId,
    leadId: request.leadId,
    services: request.services,
    discount: request.discount,
  });
  const { data: replayData, error: replayError } = await client.rpc('replay_priced_estimate', {
    p_company_id: request.companyId,
    p_actor_user_id: actor.userId,
    p_idempotency_key: request.idempotencyKey,
    p_intent_hash: intentHash,
  });
  if (replayError) {
    const conflict = /IDEMPOTENCY|already in progress|different request/iu.test(
      replayError.message,
    );
    throw new HttpError(
      conflict
        ? 'This estimate request conflicts with an existing idempotency reservation.'
        : 'Estimate replay state could not be verified.',
      conflict ? 409 : 503,
      conflict ? 'IDEMPOTENCY_CONFLICT' : 'REPLAY_UNAVAILABLE',
    );
  }
  if (replayData) return persistedEstimateReceiptSchema.parse(replayData);
  await consumeEstimateBudget(client, request.companyId, actor.userId, 'calculate');

  const measurementIds = [
    ...new Set(
      request.services.flatMap((service) => [
        service.measurementId,
        ...service.addOns.map((addOn) => addOn.measurementId),
      ]),
    ),
  ];
  const catalogCodes = [
    ...new Set(
      request.services.flatMap((service) => [
        service.serviceCode,
        ...service.addOns.map((addOn) => addOn.code),
      ]),
    ),
  ];
  const [snapshotResult, priceBook] = await Promise.all([
    client.rpc('load_estimate_calculation_snapshot', {
      p_company_id: request.companyId,
      p_actor_user_id: actor.userId,
      p_customer_id: request.customerId,
      p_property_id: request.propertyId,
      p_lead_id: request.leadId ?? null,
      p_measurement_ids: measurementIds,
      p_catalog_codes: catalogCodes,
    }),
    loadActiveBook(client, request.companyId),
  ]);
  if (snapshotResult.error) {
    const scopeMissing = /CUSTOMER_NOT_FOUND|CUSTOMER_PROPERTY_MISMATCH/iu.test(
      snapshotResult.error.message,
    );
    const leadInvalid = /ESTIMATE_LEAD_INVALID/iu.test(snapshotResult.error.message);
    const evidenceInvalid = /MEASUREMENT/iu.test(snapshotResult.error.message);
    throw new HttpError(
      scopeMissing
        ? 'The customer and property scope is missing or mismatched.'
        : leadInvalid
          ? 'The lead is not eligible for this exact estimate scope.'
          : evidenceInvalid
            ? 'Every priced quantity must reference current human-verified property evidence.'
            : 'Authoritative estimate inputs are unavailable.',
      scopeMissing || leadInvalid ? 409 : evidenceInvalid ? 422 : 503,
      scopeMissing
        ? 'CUSTOMER_PROPERTY_MISMATCH'
        : leadInvalid
          ? 'LEAD_SCOPE_MISMATCH'
          : evidenceInvalid
            ? 'MEASUREMENT_EVIDENCE_REQUIRED'
            : 'SCOPE_UNAVAILABLE',
    );
  }
  const snapshot = objectValue(snapshotResult.data, 'Estimate calculation snapshot');
  const customer = objectValue(snapshot.customer, 'Estimate customer');
  const property = objectValue(snapshot.property, 'Estimate property');
  const serviceTerms = objectValue(snapshot.service_terms, 'Approved service terms');
  const serviceCatalog = rowArray(snapshot.service_catalog, 'Selected service catalog');
  const measurements = rowArray(snapshot.measurements, 'Estimate measurements');
  const photoEvidence =
    snapshot.photo_evidence === null || snapshot.photo_evidence === undefined
      ? null
      : objectValue(snapshot.photo_evidence, 'Estimate photo evidence');
  const measurementById = new Map(
    measurements.map((measurement) => [rowText(measurement, 'id'), measurement]),
  );
  if (
    serviceCatalog.length !== catalogCodes.length ||
    serviceCatalog.some(
      (catalog) =>
        catalog.active !== true ||
        !catalogCodes.includes(rowText(catalog, 'code')) ||
        !rowText(catalog, 'safety_sop_reference').trim(),
    )
  ) {
    throw new HttpError(
      'Selected services lack exact active catalog and safety-SOP evidence.',
      409,
      'SERVICE_CATALOG_CHANGED',
    );
  }
  if (
    new Set(request.services.map((service) => service.serviceCode)).size !== request.services.length
  ) {
    throw new HttpError('A service may appear only once per estimate.', 422, 'DUPLICATE_SERVICE');
  }
  const assertedAt = new Date().toISOString();

  const storedServices = request.services.map((service) => {
    const rule = priceBook.serviceRules.find(
      (candidate) => candidate.serviceCode === service.serviceCode,
    );
    if (!rule) {
      throw new HttpError(
        `Service ${service.serviceCode} is outside the active price book.`,
        422,
        'OUTSIDE_PRICE_BOOK',
      );
    }
    const measurement = measurementById.get(service.measurementId);
    if (!measurement) {
      throw new HttpError('Service measurement evidence is missing.', 422, 'EVIDENCE_REQUIRED');
    }
    assertMeasurementForScope(measurement, rule.pricingUnit, service.serviceCode);
    const attributes = { ...service.attributes };
    if (Object.hasOwn(rule.allowedAttributeValues, 'stories')) {
      const stories = requiredStoriesValue(property.stories);
      if (attributes.stories && attributes.stories !== stories) {
        throw new HttpError(
          'Requested story classification conflicts with the property record.',
          409,
          'STORIES_MISMATCH',
        );
      }
      attributes.stories = stories;
    }
    for (const attribute of Object.keys(rule.allowedAttributeValues)) {
      const value = attributes[attribute as keyof typeof attributes];
      if (!value) {
        throw new HttpError(
          `Service ${service.serviceCode} requires operator classification ${attribute}.`,
          422,
          'CLASSIFICATION_REQUIRED',
        );
      }
    }
    const addOns = service.addOns.map((requestedAddOn) => {
      const addOnRule = rule.addOns.find((candidate) => candidate.code === requestedAddOn.code);
      if (!addOnRule) {
        throw new HttpError(
          `Add-on ${requestedAddOn.code} is outside the active price book.`,
          422,
          'OUTSIDE_PRICE_BOOK',
        );
      }
      const addOnMeasurement = measurementById.get(requestedAddOn.measurementId);
      if (!addOnMeasurement) {
        throw new HttpError('Add-on measurement evidence is missing.', 422, 'EVIDENCE_REQUIRED');
      }
      assertMeasurementForScope(
        addOnMeasurement,
        addOnRule.unit,
        service.serviceCode,
        requestedAddOn.code,
      );
      return {
        code: requestedAddOn.code,
        measurementId: requestedAddOn.measurementId,
        quantity: rowText(addOnMeasurement, 'value'),
        pricingUnit: addOnRule.unit,
      };
    });
    return {
      serviceCode: service.serviceCode,
      measurementId: service.measurementId,
      quantity: rowText(measurement, 'value'),
      pricingUnit: rule.pricingUnit,
      attributes,
      addOns,
      classificationEvidence: {
        source: 'operator_assertion',
        assertedBy: actor.userId,
        assertedAt,
      },
      sourceMeasurementIds: [
        service.measurementId,
        ...service.addOns.map((addOn) => addOn.measurementId),
      ],
    };
  });

  const evidenceDisposition =
    photoEvidence?.disposition === 'usable_for_scope'
      ? 'usable_for_scope'
      : 'human_review_required';
  const derivedTravelZone = deriveTravelZone(priceBook, property.service_address);
  if (request.travelZoneCode && request.travelZoneCode !== derivedTravelZone.code) {
    throw new HttpError(
      'Requested travel zone conflicts with the server-derived property zone.',
      409,
      'TRAVEL_ZONE_MISMATCH',
    );
  }
  const normalizedInput = {
    services: storedServices,
    travelZoneCode: derivedTravelZone.code,
    travelZoneEvidence: {
      source: derivedTravelZone.source,
      postalCode: derivedTravelZone.postalCode,
      derivedAt: assertedAt,
    },
    discount: request.discount,
  };
  const authoritativeSnapshot = {
    companyId: request.companyId,
    customer: {
      id: request.customerId,
      taxExempt: customer.tax_exempt === true,
      version: Number(customer.version),
      updatedAt: String(customer.updated_at),
    },
    property: {
      id: request.propertyId,
      stories: property.stories,
      version: Number(property.version),
      updatedAt: String(property.updated_at),
      postalCode: derivedTravelZone.postalCode,
    },
    priceBook: {
      id: priceBook.id,
      versionLabel: priceBook.versionLabel,
    },
    serviceTerms: {
      id: rowText(serviceTerms, 'id'),
      versionLabel: rowText(serviceTerms, 'version_label'),
      reviewedAt: rowText(serviceTerms, 'reviewed_at'),
      reviewReference: rowText(serviceTerms, 'review_reference'),
    },
    serviceCatalog: serviceCatalog
      .map((catalog) => ({
        id: rowText(catalog, 'id'),
        code: rowText(catalog, 'code'),
        version: Number(rowText(catalog, 'version')),
        active: catalog.active === true,
        safetySopReference: rowText(catalog, 'safety_sop_reference'),
      }))
      .sort((left, right) => left.code.localeCompare(right.code)),
    travelZone: derivedTravelZone,
    photoEvidence: photoEvidence
      ? {
          id: photoEvidence.id,
          disposition: photoEvidence.disposition,
          analyzedAt: photoEvidence.analyzed_at,
        }
      : null,
    measurements: measurements
      .map((measurement) => ({
        id: rowText(measurement, 'id'),
        value: rowText(measurement, 'value'),
        kind: rowText(measurement, 'kind'),
        unit: rowText(measurement, 'unit'),
        serviceCodes: stringArray(measurement.service_codes).sort(),
        addOnCodes: stringArray(measurement.add_on_codes).sort(),
        version: Number(rowText(measurement, 'version')),
        updatedAt: rowText(measurement, 'updated_at'),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  const snapshotHash = await sha256Hex(authoritativeSnapshot);
  const calculatedAt = assertedAt;
  const discount =
    request.discount.kind === 'none'
      ? ({ kind: 'none' } as const)
      : request.discount.kind === 'percent'
        ? ({
            kind: 'percent',
            value: asDecimalString(request.discount.value),
            reason: request.discount.reason,
          } as const)
        : ({
            kind: 'fixed',
            value: money(request.discount.value),
            reason: request.discount.reason,
          } as const);
  const result: PricingResult = calculateEstimate({
    requestId: `estimate:${snapshotHash}`,
    companyId: asDomainId(request.companyId),
    propertyId: asDomainId(request.propertyId),
    priceBook,
    services: storedServices.map((service) => ({
      serviceCode: service.serviceCode,
      quantity: asDecimalString(service.quantity),
      attributes: service.attributes,
      addOns: service.addOns.map((addOn) => ({
        code: addOn.code,
        quantity: asDecimalString(addOn.quantity),
      })),
      sourceMeasurementIds: service.sourceMeasurementIds.map(asDomainId),
    })),
    travelZoneCode: derivedTravelZone.code,
    discount,
    customerTaxExempt: customer.tax_exempt === true,
    scopeEvidenceDisposition: evidenceDisposition,
    calculatedAt: asISODateTime(calculatedAt),
  });
  if (result.issues.some((issue) => issue.severity === 'error')) {
    throw new HttpError(
      result.issues.map((issue) => issue.message).join(' '),
      422,
      'ESTIMATE_NOT_CALCULABLE',
    );
  }
  const persistedResult = {
    ...result,
    lines: result.lines.map((line) => {
      if (line.kind === 'service') {
        const service = storedServices.find(
          (candidate) => candidate.serviceCode === line.serviceCode,
        );
        if (!service) {
          throw new HttpError(
            'Calculated service provenance is inconsistent.',
            500,
            'PRICING_PROVENANCE_INVALID',
          );
        }
        return { ...line, sourceMeasurementIds: [service.measurementId] };
      }
      if (line.kind === 'add_on') {
        const service = storedServices.find(
          (candidate) => candidate.serviceCode === line.serviceCode,
        );
        const addOn = service?.addOns.find((candidate) => candidate.code === line.addOnCode);
        if (!addOn) {
          throw new HttpError(
            'Calculated add-on provenance is inconsistent.',
            500,
            'PRICING_PROVENANCE_INVALID',
          );
        }
        return { ...line, sourceMeasurementIds: [addOn.measurementId] };
      }
      return { ...line, sourceMeasurementIds: [] };
    }),
  };

  const { data, error } = await client.rpc('persist_priced_estimate', {
    p_company_id: request.companyId,
    p_actor_user_id: actor.userId,
    p_idempotency_key: request.idempotencyKey,
    p_intent_hash: intentHash,
    p_snapshot_hash: snapshotHash,
    p_authoritative_snapshot: authoritativeSnapshot,
    p_customer_id: request.customerId,
    p_property_id: request.propertyId,
    p_lead_id: request.leadId ?? null,
    p_price_book_id: priceBook.id,
    p_service_terms_id: rowText(serviceTerms, 'id'),
    p_price_book_version: priceBook.versionLabel,
    p_calculation_input: normalizedInput,
    p_result: persistedResult,
    p_terms_version: rowText(serviceTerms, 'version_label'),
    p_terms_snapshot: rowText(serviceTerms, 'terms_text'),
  });
  if (error) {
    const conflict = /IDEMPOTENCY|already in progress|different request/iu.test(error.message);
    throw new HttpError(
      conflict
        ? 'This estimate request conflicts with an existing idempotency reservation.'
        : 'The server rejected the priced estimate transaction.',
      conflict ? 409 : 422,
      conflict ? 'IDEMPOTENCY_CONFLICT' : 'ESTIMATE_PERSIST_REJECTED',
    );
  }
  return persistedEstimateReceiptSchema.parse(data);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }
  try {
    const rawBody = await readTextBody(request, 65_536);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = estimateWorkflowRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        'Estimate request fields are missing, invalid, or unsupported.',
        400,
        'INVALID_REQUEST',
      );
    }
    const client = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const actor = await authenticate(
      client,
      request.headers.get('authorization'),
      parsed.data.companyId,
    );
    const { error: expiryError } = await client.rpc('expire_pending_estimate_approvals', {
      p_company_id: parsed.data.companyId,
    });
    if (expiryError) {
      throw new HttpError(
        'Expired estimate approvals could not be reconciled.',
        503,
        'APPROVAL_RECONCILIATION_UNAVAILABLE',
      );
    }
    if (parsed.data.operation === 'context') {
      await consumeEstimateBudget(client, parsed.data.companyId, actor.userId, 'context');
    }
    const response =
      parsed.data.operation === 'context'
        ? await estimateContext(client, parsed.data.companyId, actor.userId, parsed.data.propertyId)
        : await calculateAndPersist(client, parsed.data, actor);
    return jsonResponse(response);
  } catch (error) {
    return errorResponse(error);
  }
});
