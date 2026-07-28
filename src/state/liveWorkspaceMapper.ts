import { createDemoState } from './demoSeed';
import type {
  AppRole,
  DemoApproval,
  DemoEstimate,
  DemoIncident,
  DemoIntegration,
  DemoInvoice,
  DemoLead,
  DemoNotification,
  DemoState,
  DemoVisit,
  LiveChecklistDefinition,
  LiveChecklistReference,
  LiveMaterialReference,
  LiveSdsDocumentMetadata,
} from './model';
import type { LiveWorkspace } from './liveRepository';
import type { LiveSetupState } from './liveSetup';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function records(workspace: LiveWorkspace, key: string): UnknownRecord[] {
  const value = workspace[key];
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function text(record: UnknownRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function number(record: UnknownRecord, ...keys: string[]): number {
  const value = text(record, ...keys);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integer(record: UnknownRecord, ...keys: string[]): number {
  return Math.max(0, Math.trunc(number(record, ...keys)));
}

function stringList(record: UnknownRecord, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value))
      return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/u)
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '—'
  );
}

function source(value: string): DemoLead['source'] {
  const normalized = value.toLowerCase();
  if (normalized.includes('sms')) return 'SMS';
  if (normalized.includes('phone') || normalized.includes('voice')) return 'Phone';
  if (normalized.includes('email')) return 'Email';
  if (normalized.includes('chat')) return 'Chat';
  if (normalized.includes('referral')) return 'Referral';
  if (normalized.includes('manual')) return 'Manual';
  return 'Web';
}

function leadStage(value: string): DemoLead['stage'] {
  if (value === 'qualified' || value === 'qualifying' || value === 'converted') {
    return 'qualified';
  }
  if (value === 'estimated') return 'estimated';
  if (value === 'quoted') return 'quoted';
  if (value === 'booked' || value === 'won') return 'booked';
  return 'new';
}

function estimateStatus(value: string): DemoEstimate['status'] {
  if (value === 'approved') return 'approved';
  if (value === 'pending_approval' || value === 'needs_review') return 'pending_approval';
  if (value === 'quoted' || value === 'sent' || value === 'viewed' || value === 'accepted') {
    return 'quoted';
  }
  if (value === 'ready') return 'ready';
  return 'draft';
}

function visitStatus(value: string): DemoVisit['status'] {
  if (value === 'en_route') return 'en_route';
  if (value === 'on_site' || value === 'in_progress') return 'on_site';
  if (value === 'paused') return 'paused';
  if (value === 'completed' || value === 'complete') return 'complete';
  if (value === 'weather_hold') return 'weather_hold';
  return 'ready';
}

function datePart(value: string): string {
  if (!value) return 'Not scheduled';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString().slice(0, 10);
}

function timePart(value: string): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Chicago',
      }).format(parsed);
}

function relativeAge(value: string, serverTime: string): string {
  const created = Date.parse(value);
  const current = Date.parse(serverTime);
  if (!Number.isFinite(created) || !Number.isFinite(current)) return 'unknown time';
  const minutes = Math.max(0, Math.floor((current - created) / 60_000));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  return `${Math.floor(hours / 24)} day`;
}

function serviceAddress(property: UnknownRecord | undefined): string {
  if (!property) return 'Address not projected';
  const address = asRecord(property.service_address ?? property.serviceAddress);
  const parts = [
    text(address, 'line1', 'address1', 'street'),
    text(address, 'city'),
    text(address, 'region', 'state'),
    text(address, 'postalCode', 'postal_code', 'zip'),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Address not projected';
}

function approvalReason(value: string): DemoApproval['reason'] {
  return value === 'large_discount' ||
    value === 'negative_review_response' ||
    value === 'refund' ||
    value === 'safety_message' ||
    value === 'campaign_send'
    ? value
    : 'other';
}

function incidentKind(value: string): DemoIncident['kind'] {
  if (value === 'near_miss' || value === 'property_damage' || value === 'injury_or_exposure') {
    return value;
  }
  return 'other';
}

function safeWorkspaceHref(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function mapIntegrations(workspace: LiveWorkspace): DemoIntegration[] {
  return records(workspace, 'integrationHealth').map((item) => {
    const provider = text(item, 'provider') || 'provider';
    const rawMode = text(item, 'mode');
    const rawStatus = text(item, 'status');
    return {
      id: provider,
      name: provider.replaceAll('_', ' '),
      provider,
      mode:
        rawMode === 'live'
          ? ('Live' as const)
          : rawMode === 'sandbox'
            ? ('Sandbox' as const)
            : ('Disabled' as const),
      status:
        rawStatus === 'healthy'
          ? ('Healthy' as const)
          : rawStatus === 'degraded'
            ? ('Degraded' as const)
            : ('Needs setup' as const),
      capabilities: stringList(item, 'capabilities'),
      lastCheck: text(item, 'lastCheckedAt', 'last_checked_at') || 'Not checked',
    };
  });
}

export function mapLiveWorkspace(workspace: LiveWorkspace): DemoState {
  const role = workspace.session.role as AppRole;
  const leadRows = records(workspace, 'leads');
  const customerRows = records(workspace, 'customers');
  const propertyRows = records(workspace, 'properties');
  const estimateRows = records(workspace, 'estimates');
  const quoteRows = records(workspace, 'quotes');
  const jobRows = records(workspace, 'jobs');
  const visitRows = records(workspace, 'visits');
  const checklistRows = records(workspace, 'checklistItems');
  const checklistDefinitionRows = records(workspace, 'checklistDefinitions');
  const materialRows = records(workspace, 'materials');
  const usageRows = records(workspace, 'materialUsage');
  const mediaRows = records(workspace, 'media');
  const signatureRows = records(workspace, 'completionSignatures');
  const timeRows = records(workspace, 'timeEntries');
  const approvalRows = records(workspace, 'approvals');
  const incidentRows = [
    ...records(workspace, 'incidents'),
    ...records(workspace, 'fieldIncidents').filter(
      (candidate) =>
        !records(workspace, 'incidents').some(
          (incident) => text(incident, 'id') === text(candidate, 'id'),
        ),
    ),
  ];
  const invoiceRows = records(workspace, 'invoices');
  const paymentRows = records(workspace, 'payments');
  const notificationRows = records(workspace, 'notifications');
  const recurringRows = records(workspace, 'recurringPlans');
  const postServiceFollowupRows = records(workspace, 'postServiceFollowups');
  const postServicePlanRows = records(workspace, 'postServiceMaintenancePlans');

  const customerById = new Map(customerRows.map((item) => [text(item, 'id'), item]));
  const propertyById = new Map(propertyRows.map((item) => [text(item, 'id'), item]));
  const jobById = new Map(jobRows.map((item) => [text(item, 'id'), item]));
  const materialById = new Map(materialRows.map((item) => [text(item, 'id'), item]));
  const checklistDefinitionById = new Map(
    checklistDefinitionRows.map((item) => [text(item, 'id'), item]),
  );

  const leads: DemoLead[] = leadRows.map((lead) => {
    const name = text(lead, 'display_name', 'displayName') || 'Unnamed lead';
    const services = stringList(lead, 'requested_services', 'requestedServices');
    const customerId = text(lead, 'customer_id', 'customerId') || undefined;
    const propertyId = text(lead, 'property_id', 'propertyId') || undefined;
    const property = propertyId ? propertyById.get(propertyId) : undefined;
    const addressRecord = asRecord(property?.service_address ?? property?.serviceAddress);
    return {
      id: text(lead, 'id'),
      customerId,
      propertyId,
      name,
      initials: initials(name),
      source: source(text(lead, 'source')),
      service: services.join(', ') || 'Scope not yet verified',
      address: property ? serviceAddress(property) : '',
      city: text(addressRecord, 'city'),
      stage: leadStage(text(lead, 'status')),
      value: 'Not estimated',
      age: relativeAge(text(lead, 'created_at', 'createdAt'), workspace.serverTime),
      phone: text(lead, 'phone'),
      email: text(lead, 'email'),
      priority: text(lead, 'priority') === 'high' ? 'high' : 'normal',
      consent: false,
      note: text(lead, 'qualification_summary', 'qualificationSummary'),
    };
  });

  const primaryEstimate = estimateRows[0];
  const primaryQuote =
    quoteRows.find(
      (quote) =>
        primaryEstimate && text(quote, 'estimateId', 'estimate_id') === text(primaryEstimate, 'id'),
    ) ?? quoteRows[0];
  const estimateSource = primaryEstimate ?? primaryQuote ?? {};
  const estimate: DemoEstimate = {
    id: text(estimateSource, 'id'),
    leadId: leads[0]?.id ?? '',
    estimateNumber:
      text(primaryEstimate ?? {}, 'estimateNumber', 'estimate_number') ||
      text(primaryQuote ?? {}, 'quoteNumber', 'quote_number') ||
      'No estimate',
    status: estimateStatus(
      text(primaryQuote ?? {}, 'status') || text(primaryEstimate ?? {}, 'status'),
    ),
    priceBookVersion: text(primaryEstimate ?? {}, 'priceBookVersion', 'price_book_version') || '—',
    drivewaySqFt: '0',
    gutterLinearFt: '0',
    stories: '1',
    surface: 'concrete',
    soil: 'light',
    access: 'clear',
    risk: 'standard',
    travelZone: 'DFW-A',
    discountPercent: '0',
    serviceSubtotal: text(primaryEstimate ?? {}, 'serviceSubtotal', 'service_subtotal') || '0',
    travelFee: text(primaryEstimate ?? {}, 'travelFee', 'travel_fee') || '0',
    discount: text(primaryEstimate ?? {}, 'discount') || '0',
    tax: text(primaryEstimate ?? {}, 'tax') || '0',
    total: text(primaryEstimate ?? {}, 'total') || text(primaryQuote ?? {}, 'total') || '0',
    deposit:
      text(primaryEstimate ?? {}, 'depositRequired', 'deposit_required') ||
      text(primaryQuote ?? {}, 'depositRequired', 'deposit_required') ||
      '0',
    estimatedCost: text(primaryEstimate ?? {}, 'estimatedCost', 'estimated_cost') || '0',
    marginPercent: text(primaryEstimate ?? {}, 'estimatedMarginPct', 'estimated_margin_pct') || '0',
    durationMinutes: integer(primaryEstimate ?? {}, 'durationMinutes', 'duration_minutes'),
    formulaHash:
      text(primaryEstimate ?? {}, 'calculationVersion', 'calculation_version') ||
      'Calculation snapshot not projected',
    photoEvidence: {
      confidence: 0,
      observations: [],
      unknowns: ['Photo analysis evidence is not included in this role projection.'],
      humanVerified: false,
    },
  };

  const checklistReferences: Record<string, LiveChecklistReference> = {};
  for (const item of checklistRows) {
    const id = text(item, 'id');
    const status = text(item, 'status');
    if (!id) continue;
    checklistReferences[id] = {
      id,
      version: integer(item, 'version'),
      visitId: text(item, 'visit_id', 'visitId'),
      templateItemId: text(item, 'template_item_id', 'templateItemId'),
      status:
        status === 'complete' || status === 'not_applicable' || status === 'blocked'
          ? status
          : 'pending',
    };
  }

  const visits: DemoVisit[] = visitRows.map((visit) => {
    const visitId = text(visit, 'id');
    const job = jobById.get(text(visit, 'job_id', 'jobId'));
    const customer =
      customerById.get(text(job ?? {}, 'customerId', 'customer_id')) ??
      (role === 'customer' ? customerRows[0] : undefined);
    const property = propertyById.get(text(job ?? {}, 'propertyId', 'property_id'));
    const startsAt = text(visit, 'starts_at', 'startsAt');
    const endsAt = text(visit, 'ends_at', 'endsAt');
    const activeTime = timeRows.find(
      (entry) =>
        text(entry, 'visit_id', 'visitId') === visitId && !text(entry, 'ended_at', 'endedAt'),
    );
    const completedSeconds = timeRows
      .filter(
        (entry) =>
          text(entry, 'visit_id', 'visitId') === visitId &&
          Boolean(text(entry, 'ended_at', 'endedAt')),
      )
      .reduce((total, entry) => {
        const start = Date.parse(text(entry, 'started_at', 'startedAt'));
        const end = Date.parse(text(entry, 'ended_at', 'endedAt'));
        return (
          total +
          (Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, (end - start) / 1000) : 0)
        );
      }, 0);
    const visitMedia = mediaRows.filter((media) => text(media, 'visit_id', 'visitId') === visitId);
    const visitMaterials = usageRows
      .filter((usage) => text(usage, 'visit_id', 'visitId') === visitId)
      .map((usage) => {
        const material = materialById.get(text(usage, 'material_id', 'materialId'));
        return {
          name: text(material ?? {}, 'name') || 'Material',
          amount: `${text(usage, 'quantity')} ${text(usage, 'unit')}`.trim(),
        };
      });
    return {
      id: visitId,
      jobNumber: text(job ?? {}, 'jobNumber', 'job_number') || 'Unnumbered job',
      customerName: text(customer ?? {}, 'display_name', 'displayName') || 'Customer',
      address: serviceAddress(property),
      service: stringList(job ?? {}, 'serviceCodes', 'service_codes').join(', ') || 'Service scope',
      date: datePart(startsAt),
      startsAt: timePart(startsAt),
      endsAt: timePart(endsAt),
      crew: text(visit, 'crew_id', 'crewId') || 'Assigned crew',
      status: visitStatus(text(visit, 'status')),
      weather: {
        temperature: 0,
        precipitation: 0,
        windMph: 0,
        checkedAt: 'Not projected',
        disposition: 'watch',
      },
      route: {
        driveMinutes: 0,
        miles: 0,
        checkedAt: 'Not projected',
        feasible: false,
      },
      checklist: checklistRows
        .filter((item) => text(item, 'visit_id', 'visitId') === visitId)
        .map((item) => {
          const definition = checklistDefinitionById.get(
            text(item, 'template_item_id', 'templateItemId'),
          );
          return {
            id: text(item, 'id'),
            label:
              text(definition ?? {}, 'label') ||
              `Checklist record ${text(item, 'template_item_id', 'templateItemId').slice(0, 8)}`,
            detail:
              text(item, 'note') ||
              (definition
                ? `${text(definition, 'itemKind')} evidence · server-defined requirement`
                : 'Template definition is not available in this role projection.'),
            required: definition?.required === true,
            safetyCritical: definition?.safetyCritical === true,
            complete: text(item, 'status') === 'complete',
          };
        }),
      beforePhotos: visitMedia.filter((item) => text(item, 'purpose') === 'before').length,
      afterPhotos: visitMedia.filter((item) => text(item, 'purpose') === 'after').length,
      signature: signatureRows.some(
        (signature) =>
          text(signature, 'visit_id', 'visitId') === visitId &&
          text(signature, 'signer_role', 'signerRole') === 'customer',
      ),
      timerStartedAt: activeTime ? text(activeTime, 'started_at', 'startedAt') : undefined,
      elapsedMinutes: Math.ceil(completedSeconds / 60),
      elapsedSeconds: Math.trunc(completedSeconds),
      materials: visitMaterials,
      notes: text(visit, 'internal_notes', 'internalNotes'),
    };
  });

  const approvals: DemoApproval[] = approvalRows.map((approval) => ({
    id: text(approval, 'id'),
    reason: approvalReason(text(approval, 'reason')),
    title: text(approval, 'action_type', 'actionType') || 'Approval request',
    summary: text(approval, 'summary'),
    risk:
      text(approval, 'risk_level', 'riskLevel') === 'high' ||
      text(approval, 'risk_level', 'riskLevel') === 'critical'
        ? 'high'
        : 'medium',
    status:
      text(approval, 'status') === 'approved'
        ? 'approved'
        : text(approval, 'status') === 'rejected'
          ? 'rejected'
          : 'pending',
    requestedAt: text(approval, 'requested_at', 'requestedAt'),
    expiresAt: text(approval, 'expires_at', 'expiresAt') || 'No expiry',
    entityId: text(approval, 'entity_id', 'entityId'),
    payloadPreview: JSON.stringify(approval.exactPayload ?? { payloadHash: approval.payloadHash }),
    policyVersion: text(approval, 'policy_version', 'policyVersion'),
    actionType: text(approval, 'action_type', 'actionType') || undefined,
    decidedAt: text(approval, 'decided_at', 'decidedAt') || undefined,
    consumedAt: text(approval, 'consumed_at', 'consumedAt') || undefined,
  }));

  const incidents: DemoIncident[] = incidentRows.map((incident) => {
    const visitId = text(incident, 'visit_id', 'visitId');
    return {
      id: text(incident, 'id'),
      visitId,
      jobNumber: visits.find((visit) => visit.id === visitId)?.jobNumber ?? 'Unlinked incident',
      kind: incidentKind(text(incident, 'category')),
      summary: text(incident, 'summary'),
      status: text(incident, 'status') === 'closed' ? 'closed' : 'open',
      reportedAt: text(incident, 'reported_at', 'reportedAt'),
      reportedBy: 'system',
      automationsPaused: true,
    };
  });

  const visibleInvoiceRows =
    role === 'customer'
      ? invoiceRows.filter((invoice) => text(invoice, 'status') !== 'draft')
      : invoiceRows;
  const invoices: DemoInvoice[] = visibleInvoiceRows.map((invoice) => {
    const job = jobById.get(text(invoice, 'jobId', 'job_id'));
    const customer =
      customerById.get(
        text(invoice, 'customerId', 'customer_id') || text(job ?? {}, 'customerId', 'customer_id'),
      ) ?? (role === 'customer' ? customerRows[0] : undefined);
    const rawStatus = text(invoice, 'status');
    return {
      id: text(invoice, 'id'),
      number: text(invoice, 'invoiceNumber', 'invoice_number'),
      customerName: text(customer ?? {}, 'display_name', 'displayName') || 'Customer',
      jobNumber: text(job ?? {}, 'jobNumber', 'job_number') || '—',
      issueDate: text(invoice, 'issueDate', 'issue_date'),
      dueDate: text(invoice, 'dueDate', 'due_date'),
      total: text(invoice, 'total') || '0',
      paid: text(invoice, 'amountPaid', 'amount_paid') || '0',
      balance: text(invoice, 'balanceDue', 'balance_due') || '0',
      status:
        rawStatus === 'paid'
          ? 'paid'
          : rawStatus === 'past_due' || rawStatus === 'overdue'
            ? 'past_due'
            : rawStatus === 'draft'
              ? 'draft'
              : 'open',
    };
  });

  const notifications: DemoNotification[] = notificationRows.map((notification) => ({
    id: text(notification, 'id'),
    title: text(notification, 'title'),
    body: text(notification, 'body'),
    href: safeWorkspaceHref(text(notification, 'action_url', 'actionUrl')),
    read: Boolean(text(notification, 'read_at', 'readAt')),
  }));

  const customerSummaries = customerRows.map((customer) => {
    const customerId = text(customer, 'id');
    const properties = propertyRows.filter(
      (property) => text(property, 'customer_id', 'customerId') === customerId,
    );
    const customerJobs = jobRows.filter(
      (job) => text(job, 'customer_id', 'customerId') === customerId,
    );
    const customerJobIds = new Set(customerJobs.map((job) => text(job, 'id')));
    const completedVisits = visitRows
      .filter(
        (visit) =>
          customerJobIds.has(text(visit, 'job_id', 'jobId')) &&
          ['complete', 'completed'].includes(text(visit, 'status')),
      )
      .map((visit) => text(visit, 'ends_at', 'endsAt'))
      .filter(Boolean)
      .sort();
    const lifetime = invoiceRows
      .filter((invoice) => {
        const invoiceCustomerId = text(invoice, 'customer_id', 'customerId');
        return (
          invoiceCustomerId === customerId ||
          (role === 'customer' && !invoiceCustomerId && customerRows.length === 1)
        );
      })
      .reduce((total, invoice) => total + number(invoice, 'amountPaid', 'amount_paid'), 0);
    const recurring = recurringRows
      .filter((plan) => text(plan, 'customer_id', 'customerId') === customerId)
      .map((plan) => text(plan, 'next_due_date', 'nextDueDate'))
      .filter(Boolean)
      .sort()[0];
    const rawLifecycle = text(customer, 'lifecycle');
    return {
      id: customerId,
      name: text(customer, 'display_name', 'displayName') || 'Unnamed customer',
      email: text(customer, 'email'),
      phone: text(customer, 'phone'),
      properties: properties.length,
      address: serviceAddress(properties[0]),
      lifetime: new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: workspace.company.currency || 'USD',
      }).format(lifetime),
      lastService: completedVisits.at(-1) ?? 'No completed visit',
      nextDue: recurring ?? 'No recurring due date',
      status:
        Boolean(customer.do_not_contact) || rawLifecycle === 'blocked'
          ? ('Attention' as const)
          : rawLifecycle === 'active'
            ? ('Active' as const)
            : ('Lead' as const),
    };
  });

  const checklistDefinitions: Record<string, LiveChecklistDefinition> = Object.fromEntries(
    checklistDefinitionRows.map((definition) => [
      text(definition, 'id'),
      {
        id: text(definition, 'id'),
        templateId: text(definition, 'templateId', 'template_id'),
        label: text(definition, 'label'),
        itemKind:
          text(definition, 'itemKind', 'item_kind') === 'text' ||
          text(definition, 'itemKind', 'item_kind') === 'number' ||
          text(definition, 'itemKind', 'item_kind') === 'photo' ||
          text(definition, 'itemKind', 'item_kind') === 'signature'
            ? (text(definition, 'itemKind', 'item_kind') as LiveChecklistDefinition['itemKind'])
            : 'boolean',
        required: definition.required === true,
        safetyCritical: definition.safetyCritical === true,
        sortOrder: integer(definition, 'sortOrder', 'sort_order'),
      },
    ]),
  );
  const materialReferences: LiveMaterialReference[] = materialRows.map((material) => {
    const sdsRecord = asRecord(material.sdsDocument ?? material.sds_document);
    const sdsDocument: LiveSdsDocumentMetadata | undefined = text(sdsRecord, 'id')
      ? {
          id: text(sdsRecord, 'id'),
          version: integer(sdsRecord, 'version'),
          productName: text(sdsRecord, 'productName', 'product_name'),
          manufacturer: text(sdsRecord, 'manufacturer'),
          revisionDate: text(sdsRecord, 'revisionDate', 'revision_date'),
          reviewedAt: text(sdsRecord, 'reviewedAt', 'reviewed_at') || undefined,
          checksumSha256: text(sdsRecord, 'checksumSha256', 'checksum_sha256'),
          storageObjectPath: text(sdsRecord, 'storageObjectPath', 'storage_object_path'),
        }
      : undefined;
    return {
      id: text(material, 'id'),
      version: integer(material, 'version'),
      name: text(material, 'name'),
      unit: text(material, 'unit'),
      requiresSds: material.requiresSds === true || material.requires_sds === true,
      sdsDocument,
    };
  });
  const primaryVisit = visitRows[0];
  const primaryVisitId = text(primaryVisit ?? {}, 'id');
  const primaryVisitJob = jobById.get(text(primaryVisit ?? {}, 'job_id', 'jobId'));
  const primaryJob =
    primaryVisitJob ??
    jobRows.find((job) => text(job, 'quoteId', 'quote_id') === text(primaryQuote ?? {}, 'id')) ??
    jobRows[0];
  const primaryInvoice =
    invoiceRows.find(
      (invoice) =>
        text(invoice, 'jobId', 'job_id') === text(primaryJob ?? {}, 'id') &&
        text(invoice, 'purpose') !== 'other',
    ) ?? invoiceRows[0];
  const postServiceInvoice = invoiceRows.find(
    (invoice) =>
      text(invoice, 'status') === 'paid' && number(invoice, 'balanceDue', 'balance_due') === 0,
  );
  const postServiceInvoiceId = text(postServiceInvoice ?? {}, 'id');
  const reviewFollowup = postServiceFollowupRows.find(
    (followup) =>
      text(followup, 'invoiceId', 'invoice_id') === postServiceInvoiceId &&
      text(followup, 'action') === 'review.request',
  );
  const referralFollowup = postServiceFollowupRows.find(
    (followup) =>
      text(followup, 'invoiceId', 'invoice_id') === postServiceInvoiceId &&
      text(followup, 'action') === 'referral.invite',
  );
  const maintenancePlan = postServicePlanRows.find(
    (plan) =>
      text(plan, 'invoiceId', 'source_invoice_id') === postServiceInvoiceId &&
      text(plan, 'status') === 'active',
  );
  const activeTime = timeRows.find(
    (entry) =>
      text(entry, 'visit_id', 'visitId') === primaryVisitId && !text(entry, 'ended_at', 'endedAt'),
  );
  const quoteStatus = text(primaryQuote ?? {}, 'status');
  const successfulPayments = paymentRows.filter((payment) =>
    ['succeeded', 'paid', 'captured'].includes(text(payment, 'status')),
  );
  const depositRequired = number(primaryQuote ?? {}, 'depositRequired', 'deposit_required');
  const projectedDepositPaid = number(primaryInvoice ?? {}, 'amountPaid', 'amount_paid');
  const base = createDemoState();

  return {
    ...base,
    hydrated: true,
    dataMode: 'supabase',
    authStatus: 'signed_in',
    liveError: undefined,
    setupComplete: true,
    role,
    online: navigator.onLine,
    syncRevision: 0,
    selectedLeadId: leads[0]?.id ?? '',
    leads,
    estimate,
    approvals,
    visits,
    incidents,
    invoices,
    remindedInvoiceIds: [],
    traces: [],
    auditEvents: [],
    automations: [],
    notifications,
    toasts: [],
    offlineQueue: [],
    integrations: mapIntegrations(workspace),
    customerQuoteAccepted: quoteStatus === 'accepted',
    depositPaid:
      depositRequired === 0 ||
      (projectedDepositPaid >= depositRequired &&
        successfulPayments.some(
          (payment) => text(payment, 'paymentType', 'payment_type') === 'deposit',
        )),
    reviewRequested: Boolean(reviewFollowup),
    referralInvited: Boolean(referralFollowup),
    recurringPlanActive:
      Boolean(maintenancePlan) || recurringRows.some((plan) => text(plan, 'status') === 'active'),
    live: {
      userId: workspace.session.userId,
      companyId: workspace.session.companyId,
      companyName: workspace.company.name,
      companyTimezone: workspace.company.timezone,
      customerName: text(customerRows[0] ?? {}, 'display_name', 'displayName') || undefined,
      serverTime: workspace.serverTime,
      quote: primaryQuote
        ? {
            id: text(primaryQuote, 'id'),
            version: integer(primaryQuote, 'version'),
          }
        : undefined,
      quoteStatus: text(primaryQuote ?? {}, 'status') || undefined,
      quoteTermsSnapshot:
        typeof primaryQuote?.termsSnapshot === 'string'
          ? primaryQuote.termsSnapshot
          : primaryQuote?.termsSnapshot
            ? JSON.stringify(primaryQuote.termsSnapshot)
            : undefined,
      visit: primaryVisit
        ? {
            id: primaryVisitId,
            version: integer(primaryVisit, 'version'),
          }
        : undefined,
      visitStatus: text(primaryVisit ?? {}, 'status') || undefined,
      visitStartsAt: text(primaryVisit ?? {}, 'starts_at', 'startsAt') || undefined,
      visitEndsAt: text(primaryVisit ?? {}, 'ends_at', 'endsAt') || undefined,
      job: primaryJob
        ? {
            id: text(primaryJob, 'id'),
            version: integer(primaryJob, 'version'),
          }
        : undefined,
      jobStatus: text(primaryJob ?? {}, 'status') || undefined,
      jobId: text(primaryJob ?? {}, 'id') || undefined,
      invoice: primaryInvoice
        ? {
            id: text(primaryInvoice, 'id'),
            version: integer(primaryInvoice, 'version'),
          }
        : undefined,
      postServiceInvoice: postServiceInvoice
        ? {
            id: postServiceInvoiceId,
            version: integer(postServiceInvoice, 'version'),
          }
        : undefined,
      postServiceReviewStatus: reviewFollowup
        ? (text(reviewFollowup, 'status') as
            | 'queued'
            | 'submitted'
            | 'reconciliation_required'
            | 'submitted_unknown'
            | 'completed'
            | 'sandboxed'
            | 'failed'
            | 'cancelled')
        : undefined,
      postServiceReferralStatus: referralFollowup
        ? (text(referralFollowup, 'status') as
            | 'queued'
            | 'submitted'
            | 'reconciliation_required'
            | 'submitted_unknown'
            | 'completed'
            | 'sandboxed'
            | 'failed'
            | 'cancelled')
        : undefined,
      postServiceMaintenanceStatus: maintenancePlan ? 'active' : undefined,
      invoiceVersions: Object.fromEntries(
        invoiceRows.map((invoice) => [text(invoice, 'id'), integer(invoice, 'version')]),
      ),
      customerId:
        text(primaryJob ?? {}, 'customerId', 'customer_id') ||
        (role === 'customer' ? text(customerRows[0] ?? {}, 'id') : undefined),
      propertyId:
        text(primaryJob ?? {}, 'propertyId', 'property_id') ||
        (role === 'customer' ? text(propertyRows[0] ?? {}, 'id') : undefined),
      activeTimeEntry: activeTime
        ? { id: text(activeTime, 'id'), version: integer(activeTime, 'version') }
        : undefined,
      leadVersions: Object.fromEntries(
        leadRows.map((lead) => [text(lead, 'id'), integer(lead, 'version')]),
      ),
      checklistItems: checklistReferences,
      checklistDefinitions,
      incidentVersions: Object.fromEntries(
        incidentRows.map((incident) => [text(incident, 'id'), integer(incident, 'version')]),
      ),
      notificationVersions: Object.fromEntries(
        notificationRows.map((item) => [text(item, 'id'), integer(item, 'version')]),
      ),
      approvalVersions: Object.fromEntries(
        approvalRows.map((item) => [text(item, 'id'), integer(item, 'version')]),
      ),
      materials: materialReferences,
      customers: customerSummaries,
      properties: propertyRows.map((property) => ({
        id: text(property, 'id'),
        customerId: text(property, 'customer_id', 'customerId'),
        name: text(property, 'name') || 'Unnamed property',
        address: serviceAddress(property),
      })),
    },
  };
}

export function createSignedOutLiveState(error?: string): DemoState {
  const base = createDemoState();
  return {
    ...base,
    hydrated: true,
    dataMode: 'supabase',
    authStatus: error ? 'error' : 'signed_out',
    liveError: error,
    setupComplete: true,
    selectedLeadId: '',
    leads: [],
    approvals: [],
    visits: [],
    incidents: [],
    invoices: [],
    traces: [],
    auditEvents: [],
    automations: [],
    notifications: [],
    toasts: [],
    offlineQueue: [],
    integrations: [],
    customerQuoteAccepted: false,
    depositPaid: false,
    reviewRequested: false,
    referralInvited: false,
    recurringPlanActive: false,
  };
}

export function createLiveSetupRequiredState(setupState: LiveSetupState): DemoState {
  if (setupState.status !== 'required') {
    throw new Error('Only a setup-required server state can open authenticated onboarding.');
  }
  const companyId = setupState.companyId ?? setupState.requestedCompanyId;
  if (!companyId) {
    throw new Error('Authenticated setup requires the configured company UUID.');
  }
  const base = createSignedOutLiveState();
  return {
    ...base,
    authStatus: 'signed_in',
    setupComplete: false,
    role: 'owner',
    online: true,
    live: {
      userId: setupState.userId,
      companyId,
      companyName: setupState.companyName ?? 'StoryOps setup workspace',
      companyTimezone: 'America/Chicago',
      serverTime: '',
      invoiceVersions: {},
      leadVersions: {},
      checklistItems: {},
      checklistDefinitions: {},
      incidentVersions: {},
      notificationVersions: {},
      approvalVersions: {},
      materials: [],
      customers: [],
      properties: [],
    },
  };
}
