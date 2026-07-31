import { createDemoState } from './demoSeed';
import type {
  AppRole,
  DemoApproval,
  DemoEstimate,
  DemoFieldAccessFacts,
  DemoFieldChangeRequest,
  DemoFieldEvidence,
  DemoFieldScopeLine,
  DemoIncident,
  DemoIntegration,
  DemoInvoice,
  DemoLead,
  DemoNotification,
  DemoState,
  DemoVisit,
  LiveChecklistDefinition,
  LiveChecklistReference,
  LiveDispatchJobReference,
  LiveFieldVisitReference,
  LiveMaterialReference,
  LiveSdsDocumentMetadata,
  LiveTransactionalDelivery,
  OfflineMutation,
} from './model';
import type { LiveWorkspace } from './liveRepository';
import type { LiveSetupState } from './liveSetup';
import type { CompanyControlState } from './companyControl';
import { selectReadyDispatchJobId, selectRoleScopedVisitId } from './visitSelection';

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

function optionalNumber(record: UnknownRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
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
  if (
    value === 'quoted' ||
    value === 'sent' ||
    value === 'viewed' ||
    value === 'accepted' ||
    value === 'declined' ||
    value === 'change_requested'
  ) {
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

function datePart(value: string, timeZone: string): string {
  if (!value) return 'Not scheduled';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  return year && month && day ? `${year}-${month}-${day}` : value;
}

function timePart(value: string, timeZone: string): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone,
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

function approvalRisk(value: string): DemoApproval['risk'] {
  if (value === 'low' || value === 'high' || value === 'critical') return value;
  return 'medium';
}

function approvalBlockingFlags(
  approval: UnknownRecord,
): NonNullable<DemoApproval['blockingFlags']> {
  const exactPayload = asRecord(approval.exactPayload);
  const flags = exactPayload.blockingFlags;
  if (!Array.isArray(flags)) return [];
  return flags.flatMap((value) => {
    const flag = asRecord(value);
    const reason = text(flag, 'reason');
    const summary = text(flag, 'summary');
    if (!reason || !summary || flag.blocking !== true) return [];
    return [
      {
        reason,
        riskLevel: approvalRisk(text(flag, 'riskLevel', 'risk_level')),
        summary,
      },
    ];
  });
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
  if (workspace.providerLaunch) {
    const connections = workspace.providerLaunch.connections.map((connection) => ({
      id: connection.provider,
      name: connection.provider.replaceAll('_', ' '),
      provider: connection.provider,
      mode:
        connection.mode === 'live'
          ? ('Live' as const)
          : connection.mode === 'sandbox'
            ? ('Sandbox' as const)
            : ('Disabled' as const),
      status:
        connection.environmentStatus === 'healthy'
          ? ('Healthy' as const)
          : connection.environmentStatus === 'degraded' || connection.environmentStatus === 'down'
            ? ('Degraded' as const)
            : ('Needs setup' as const),
      capabilities: connection.capabilities,
      lastCheck: connection.environmentCheckedAt ?? 'Not checked',
      version: connection.version,
    }));
    const schedulingGate = workspace.providerLaunch.schedulingGate;
    return schedulingGate
      ? [
          ...connections,
          {
            id: `${schedulingGate.provider}:${schedulingGate.capability}`,
            name: 'scheduling evidence gate',
            provider: schedulingGate.provider,
            mode:
              schedulingGate.mode === 'live'
                ? ('Live' as const)
                : schedulingGate.mode === 'sandbox'
                  ? ('Sandbox' as const)
                  : ('Disabled' as const),
            status:
              schedulingGate.status === 'healthy'
                ? ('Healthy' as const)
                : schedulingGate.status === 'degraded' || schedulingGate.status === 'down'
                  ? ('Degraded' as const)
                  : ('Needs setup' as const),
            capabilities: [schedulingGate.capability],
            lastCheck: schedulingGate.checkedAt,
          },
        ]
      : connections;
  }
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
      version: integer(item, 'version') || undefined,
    };
  });
}

function mapTransactionalDelivery(
  record: UnknownRecord | undefined,
): LiveTransactionalDelivery | undefined {
  if (!record) return undefined;
  const action = text(record, 'action');
  const channel = text(record, 'channel');
  const status = text(record, 'status');
  if (
    !['quote.delivery', 'visit.on_my_way'].includes(action) ||
    !['sms', 'email'].includes(channel) ||
    ![
      'queued',
      'submitting',
      'submitted',
      'submitted_unknown',
      'delivered',
      'sandboxed',
      'failed',
      'cancelled',
    ].includes(status)
  ) {
    return undefined;
  }
  const providerMode = text(record, 'providerMode', 'provider_mode');
  const providerStatus = text(record, 'providerStatus', 'provider_status');
  return {
    id: text(record, 'id'),
    action: action as LiveTransactionalDelivery['action'],
    entityId: text(record, 'entityId', 'entity_id'),
    entityVersion: integer(record, 'entityVersion', 'entity_version'),
    channel: channel as LiveTransactionalDelivery['channel'],
    status: status as LiveTransactionalDelivery['status'],
    providerMode: providerMode === 'sandbox' || providerMode === 'live' ? providerMode : undefined,
    providerStatus: [
      'accepted',
      'queued',
      'sent',
      'delivered',
      'failed',
      'submission_unknown',
      'sandbox_recorded',
    ].includes(providerStatus)
      ? (providerStatus as LiveTransactionalDelivery['providerStatus'])
      : undefined,
    lastErrorCode: text(record, 'lastErrorCode', 'last_error_code') || undefined,
    manualReconciliationRequired:
      record.manualReconciliationRequired === true ||
      record.manual_reconciliation_required === true,
    providerSubmissionAsserted:
      record.providerSubmissionAsserted === true || record.provider_submission_asserted === true,
    externalDeliveryClaimed:
      record.externalDeliveryClaimed === true || record.external_delivery_claimed === true,
    requestedAt: text(record, 'requestedAt', 'requested_at'),
    completedAt: text(record, 'completedAt', 'completed_at') || undefined,
    version: integer(record, 'version'),
  };
}

export interface LiveWorkspaceSelection {
  portalCustomerId?: string;
  selectedVisitId?: string;
  selectedDispatchJobId?: string;
}

export function mapLiveWorkspace(
  workspace: LiveWorkspace,
  selection: LiveWorkspaceSelection = {},
): DemoState {
  const role = workspace.session.role as AppRole;
  const leadRows = records(workspace, 'leads');
  const allCustomerRows = records(workspace, 'customers');
  const allPropertyRows = records(workspace, 'properties');
  const estimateRows = records(workspace, 'estimates');
  const allQuoteRows = records(workspace, 'quotes');
  const allJobRows = records(workspace, 'jobs');
  const allVisitRows = records(workspace, 'visits');
  const allInvoiceRows = records(workspace, 'invoices');

  const projectedPortalCustomerIds = new Set(
    workspace.customerPortal?.customers.map((customer) => customer.customerId) ?? [],
  );
  const portalAccounts =
    role === 'customer'
      ? allCustomerRows
          .map((customer) => ({
            customerId: text(customer, 'id'),
            displayName:
              text(customer, 'display_name', 'displayName') || 'Unnamed customer account',
          }))
          .filter(
            (account) =>
              account.customerId.length > 0 && projectedPortalCustomerIds.has(account.customerId),
          )
          .sort(
            (left, right) =>
              left.displayName.localeCompare(right.displayName) ||
              left.customerId.localeCompare(right.customerId),
          )
      : [];
  const selectedPortalCustomerId =
    role === 'customer'
      ? portalAccounts.some((account) => account.customerId === selection.portalCustomerId)
        ? selection.portalCustomerId
        : portalAccounts[0]?.customerId
      : undefined;
  const customerRows =
    role === 'customer'
      ? allCustomerRows.filter((customer) => text(customer, 'id') === selectedPortalCustomerId)
      : allCustomerRows;
  const propertyRows =
    role === 'customer'
      ? allPropertyRows.filter(
          (property) => text(property, 'customer_id', 'customerId') === selectedPortalCustomerId,
        )
      : allPropertyRows;
  const selectedPropertyIds = new Set(propertyRows.map((property) => text(property, 'id')));
  const quoteRows =
    role === 'customer'
      ? allQuoteRows.filter((quote) =>
          selectedPropertyIds.has(text(quote, 'property_id', 'propertyId')),
        )
      : allQuoteRows;
  const jobRows =
    role === 'customer'
      ? allJobRows.filter((job) => selectedPropertyIds.has(text(job, 'property_id', 'propertyId')))
      : allJobRows;
  const selectedJobIds = new Set(jobRows.map((job) => text(job, 'id')));
  const visitRows =
    role === 'customer'
      ? allVisitRows.filter((visit) => selectedJobIds.has(text(visit, 'job_id', 'jobId')))
      : allVisitRows;
  const selectedVisitIds = new Set(visitRows.map((visit) => text(visit, 'id')));
  const selectedVisitId = selectRoleScopedVisitId(
    visitRows.map((visit) => ({
      id: text(visit, 'id'),
      status: text(visit, 'status'),
      startsAt: text(visit, 'starts_at', 'startsAt') || undefined,
      endsAt: text(visit, 'ends_at', 'endsAt') || undefined,
    })),
    {
      preferredVisitId: selection.selectedVisitId,
      serverTime: workspace.serverTime,
      timeZone: workspace.company.timezone || 'UTC',
    },
  );
  const invoiceRows =
    role === 'customer'
      ? allInvoiceRows.filter((invoice) => selectedJobIds.has(text(invoice, 'job_id', 'jobId')))
      : allInvoiceRows;
  const selectedInvoiceIds = new Set(invoiceRows.map((invoice) => text(invoice, 'id')));
  const fieldPacketRows = records(workspace, 'fieldPackets').filter(
    (packet) => role !== 'customer' || selectedVisitIds.has(text(packet, 'visitId', 'visit_id')),
  );
  const checklistRows = records(workspace, 'checklistItems').filter(
    (item) => role !== 'customer' || selectedVisitIds.has(text(item, 'visitId', 'visit_id')),
  );
  const checklistDefinitionRows = records(workspace, 'checklistDefinitions');
  const materialRows = records(workspace, 'materials');
  const usageRows = records(workspace, 'materialUsage').filter(
    (usage) => role !== 'customer' || selectedVisitIds.has(text(usage, 'visitId', 'visit_id')),
  );
  const mediaRows = records(workspace, 'media').filter(
    (media) =>
      role !== 'customer' || selectedPropertyIds.has(text(media, 'propertyId', 'property_id')),
  );
  const signatureRows = records(workspace, 'completionSignatures').filter(
    (signature) =>
      role !== 'customer' || selectedVisitIds.has(text(signature, 'visitId', 'visit_id')),
  );
  const timeRows = records(workspace, 'timeEntries').filter(
    (entry) => role !== 'customer' || selectedVisitIds.has(text(entry, 'visitId', 'visit_id')),
  );
  const approvalRows = records(workspace, 'approvals');
  const allIncidentRows = [
    ...records(workspace, 'incidents'),
    ...records(workspace, 'fieldIncidents').filter(
      (candidate) =>
        !records(workspace, 'incidents').some(
          (incident) => text(incident, 'id') === text(candidate, 'id'),
        ),
    ),
  ];
  const incidentRows = allIncidentRows.filter(
    (incident) =>
      role !== 'customer' ||
      selectedVisitIds.has(text(incident, 'visitId', 'visit_id')) ||
      selectedJobIds.has(text(incident, 'jobId', 'job_id')) ||
      selectedPropertyIds.has(text(incident, 'propertyId', 'property_id')),
  );
  const notificationRows = records(workspace, 'notifications').filter(
    (notification) =>
      role !== 'customer' ||
      text(notification, 'recipientCustomerId', 'recipient_customer_id') ===
        selectedPortalCustomerId,
  );
  const recurringRows = records(workspace, 'recurringPlans').filter(
    (plan) =>
      role !== 'customer' || text(plan, 'customerId', 'customer_id') === selectedPortalCustomerId,
  );
  const postServiceFollowupRows = records(workspace, 'postServiceFollowups').filter(
    (followup) =>
      role !== 'customer' || selectedInvoiceIds.has(text(followup, 'invoiceId', 'invoice_id')),
  );
  const postServicePlanRows = records(workspace, 'postServiceMaintenancePlans').filter(
    (plan) =>
      role !== 'customer' || selectedInvoiceIds.has(text(plan, 'invoiceId', 'source_invoice_id')),
  );
  const selectedQuoteIds = new Set(quoteRows.map((quote) => text(quote, 'id')));
  const transactionalDeliveryRows = records(workspace, 'transactionalDeliveries').filter(
    (delivery) =>
      role !== 'customer' ||
      selectedQuoteIds.has(text(delivery, 'entityId', 'entity_id')) ||
      selectedVisitIds.has(text(delivery, 'entityId', 'entity_id')),
  );

  const customerById = new Map(customerRows.map((item) => [text(item, 'id'), item]));
  const propertyById = new Map(propertyRows.map((item) => [text(item, 'id'), item]));
  const jobById = new Map(jobRows.map((item) => [text(item, 'id'), item]));
  const materialById = new Map(materialRows.map((item) => [text(item, 'id'), item]));
  const checklistDefinitionById = new Map(
    checklistDefinitionRows.map((item) => [text(item, 'id'), item]),
  );
  const fieldPacketByVisitId = new Map(
    fieldPacketRows.map((item) => [text(item, 'visitId', 'visit_id'), item]),
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
    downspoutCount: '0',
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

  const allChecklistReferences: Record<string, LiveChecklistReference> = {};
  for (const item of checklistRows) {
    const id = text(item, 'id');
    const status = text(item, 'status');
    if (!id) continue;
    allChecklistReferences[id] = {
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
  const checklistReferences = Object.fromEntries(
    Object.entries(allChecklistReferences).filter(
      ([, reference]) => reference.visitId === selectedVisitId,
    ),
  );

  const visits: DemoVisit[] = visitRows.map((visit) => {
    const visitId = text(visit, 'id');
    const fieldPacket = fieldPacketByVisitId.get(visitId);
    const routeEvidence = asRecord(fieldPacket?.routeEvidence ?? fieldPacket?.route_evidence);
    const weatherEvidence = asRecord(fieldPacket?.weatherEvidence ?? fieldPacket?.weather_evidence);
    const accessRecord = asRecord(fieldPacket?.access);
    const scopeLines: DemoFieldScopeLine[] = Array.isArray(fieldPacket?.scopeLines)
      ? fieldPacket.scopeLines.map(asRecord).map((line) => ({
          id: text(line, 'id'),
          lineKind: text(line, 'lineKind', 'line_kind') === 'add_on' ? 'add_on' : 'service',
          serviceCode: text(line, 'serviceCode', 'service_code') || undefined,
          addOnCode: text(line, 'addOnCode', 'add_on_code') || undefined,
          description: text(line, 'description'),
          quantity: text(line, 'quantity'),
          unit: text(line, 'unit'),
          sortOrder: integer(line, 'sortOrder', 'sort_order'),
        }))
      : [];
    const fieldEvidence: DemoFieldEvidence[] = Array.isArray(fieldPacket?.evidence)
      ? fieldPacket.evidence.map(asRecord).map((evidence) => ({
          id: text(evidence, 'id'),
          purpose: text(evidence, 'purpose') === 'after' ? 'after' : 'before',
          contentType: text(evidence, 'contentType', 'content_type') as
            'image/jpeg' | 'image/png' | 'image/webp',
          byteSize: integer(evidence, 'byteSize', 'byte_size'),
          checksumSha256: text(evidence, 'checksumSha256', 'checksum_sha256'),
          capturedAt: text(evidence, 'capturedAt', 'captured_at'),
          syncState: text(evidence, 'syncState', 'sync_state') as 'pending' | 'synced' | 'failed',
          customerVisible: evidence.customerVisible === true || evidence.customer_visible === true,
        }))
      : [];
    const changeRequests: DemoFieldChangeRequest[] = Array.isArray(fieldPacket?.changeRequests)
      ? fieldPacket.changeRequests.map(asRecord).map((request) => ({
          id: text(request, 'id'),
          reasonCode: text(request, 'reasonCode', 'reason_code') as
            'scope_mismatch' | 'access_blocked' | 'customer_request' | 'site_condition' | 'other',
          summary: text(request, 'summary'),
          status: text(request, 'status') as 'submitted' | 'reviewing' | 'resolved' | 'cancelled',
          createdAt: text(request, 'createdAt', 'created_at'),
          version: integer(request, 'version'),
        }))
      : [];
    const access: DemoFieldAccessFacts = {
      instructions: text(accessRecord, 'instructions') || undefined,
      waterSourceNotes: text(accessRecord, 'waterSourceNotes', 'water_source_notes') || undefined,
      drainageNotes: text(accessRecord, 'drainageNotes', 'drainage_notes') || undefined,
      knownHazards: stringList(accessRecord, 'knownHazards', 'known_hazards'),
    };
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
      service:
        scopeLines.map((line) => line.description).join(', ') ||
        stringList(job ?? {}, 'serviceCodes', 'service_codes').join(', ') ||
        'Accepted scope not projected',
      date: datePart(startsAt, workspace.company.timezone || 'UTC'),
      startsAt: timePart(startsAt, workspace.company.timezone || 'UTC'),
      endsAt: timePart(endsAt, workspace.company.timezone || 'UTC'),
      crew: text(visit, 'crew_id', 'crewId') || 'Assigned crew',
      status: visitStatus(text(visit, 'status')),
      weather: text(weatherEvidence, 'id')
        ? {
            temperature: optionalNumber(weatherEvidence, 'temperatureF', 'temperature_f'),
            precipitation:
              optionalNumber(
                weatherEvidence,
                'precipitationProbability',
                'precipitation_probability',
              ) === undefined
                ? undefined
                : Number(
                    (
                      (optionalNumber(
                        weatherEvidence,
                        'precipitationProbability',
                        'precipitation_probability',
                      ) ?? 0) * 100
                    ).toFixed(2),
                  ),
            windMph: optionalNumber(weatherEvidence, 'windSpeedMph', 'wind_speed_mph'),
            checkedAt: text(weatherEvidence, 'checkedAt', 'checked_at') || undefined,
            disposition:
              text(weatherEvidence, 'policyDisposition', 'policy_disposition') === 'eligible'
                ? 'clear'
                : text(weatherEvidence, 'policyDisposition', 'policy_disposition') === 'unavailable'
                  ? 'hold'
                  : 'watch',
            provider: text(weatherEvidence, 'provider') as 'nws' | 'mock',
            evidenceMode: text(weatherEvidence, 'evidenceMode', 'evidence_mode') as
              'live' | 'sandbox',
            freshness: text(weatherEvidence, 'freshness') as 'current' | 'stale',
            forecastIssuedAt:
              text(weatherEvidence, 'forecastIssuedAt', 'forecast_issued_at') || undefined,
            periodStartsAt:
              text(weatherEvidence, 'periodStartsAt', 'period_starts_at') || undefined,
            periodEndsAt: text(weatherEvidence, 'periodEndsAt', 'period_ends_at') || undefined,
            lightningRisk: text(weatherEvidence, 'lightningRisk', 'lightning_risk') as
              'none' | 'low' | 'elevated' | 'severe' | 'unknown',
            conditionCodes: stringList(weatherEvidence, 'conditionCodes', 'condition_codes'),
            policyDisposition: text(weatherEvidence, 'policyDisposition', 'policy_disposition') as
              'eligible' | 'requires_approval' | 'unavailable',
          }
        : {},
      route: text(routeEvidence, 'id')
        ? {
            driveMinutes: optionalNumber(routeEvidence, 'driveMinutes', 'drive_minutes'),
            miles: optionalNumber(routeEvidence, 'distanceMiles', 'distance_miles'),
            checkedAt: text(routeEvidence, 'checkedAt', 'checked_at') || undefined,
            feasible:
              typeof routeEvidence.routeFeasible === 'boolean'
                ? routeEvidence.routeFeasible
                : typeof routeEvidence.route_feasible === 'boolean'
                  ? routeEvidence.route_feasible
                  : undefined,
            provider: text(routeEvidence, 'provider') as 'vroom' | 'mock',
            evidenceMode: text(routeEvidence, 'evidenceMode', 'evidence_mode') as
              'live' | 'sandbox',
            freshness: text(routeEvidence, 'freshness') as 'current' | 'stale',
            violations: stringList(routeEvidence, 'violations'),
          }
        : {},
      scopeLines,
      exclusions: Array.isArray(fieldPacket?.exclusions)
        ? fieldPacket.exclusions.filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0,
          )
        : [],
      exclusionsStatus: fieldPacket?.exclusionsStatus === 'recorded' ? 'recorded' : 'not_recorded',
      access,
      fieldEvidence,
      changeRequests,
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
      beforePhotos: fieldPacket
        ? fieldEvidence.filter((item) => item.purpose === 'before').length
        : visitMedia.filter((item) => text(item, 'purpose') === 'before').length,
      afterPhotos: fieldPacket
        ? fieldEvidence.filter((item) => item.purpose === 'after').length
        : visitMedia.filter((item) => text(item, 'purpose') === 'after').length,
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

  const approvals: DemoApproval[] = approvalRows.map((approval) => {
    const exactPayload = approval.exactPayload;
    const payloadHash = text(approval, 'payloadHash', 'payload_hash') || undefined;
    return {
      id: text(approval, 'id'),
      reason: approvalReason(text(approval, 'reason')),
      title: text(approval, 'action_type', 'actionType') || 'Approval request',
      summary: text(approval, 'summary'),
      risk: approvalRisk(text(approval, 'risk_level', 'riskLevel')),
      status:
        text(approval, 'status') === 'approved'
          ? 'approved'
          : text(approval, 'status') === 'rejected'
            ? 'rejected'
            : 'pending',
      requestedAt: text(approval, 'requested_at', 'requestedAt'),
      expiresAt: text(approval, 'expires_at', 'expiresAt') || 'No expiry',
      entityId: text(approval, 'entity_id', 'entityId'),
      payloadPreview: JSON.stringify(
        exactPayload ?? { unavailable: true, payloadHash: payloadHash ?? null },
        null,
        2,
      ),
      payloadHash,
      blockingFlags: approvalBlockingFlags(approval),
      policyVersion: text(approval, 'policy_version', 'policyVersion'),
      actionType: text(approval, 'action_type', 'actionType') || undefined,
      decidedAt: text(approval, 'decided_at', 'decidedAt') || undefined,
      consumedAt: text(approval, 'consumed_at', 'consumedAt') || undefined,
    };
  });

  const incidents: DemoIncident[] = incidentRows.map((incident) => {
    const visitId = text(incident, 'visit_id', 'visitId');
    const jobId = text(incident, 'job_id', 'jobId') || undefined;
    const propertyId = text(incident, 'property_id', 'propertyId') || undefined;
    return {
      id: text(incident, 'id'),
      visitId,
      jobId,
      propertyId,
      jobNumber:
        visits.find((visit) => visit.id === visitId)?.jobNumber ??
        (text(jobById.get(jobId ?? '') ?? {}, 'jobNumber', 'job_number') || 'Unlinked incident'),
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
          documentVersion: integer(sdsRecord, 'documentVersion', 'document_version') || undefined,
          productName: text(sdsRecord, 'productName', 'product_name'),
          manufacturer: text(sdsRecord, 'manufacturer'),
          revisionDate: text(sdsRecord, 'revisionDate', 'revision_date'),
          reviewedAt: text(sdsRecord, 'reviewedAt', 'reviewed_at') || undefined,
          checksumSha256: text(sdsRecord, 'checksumSha256', 'checksum_sha256'),
          storageObjectPath: text(sdsRecord, 'storageObjectPath', 'storage_object_path'),
          contentType:
            text(sdsRecord, 'contentType', 'content_type') === 'application/pdf'
              ? 'application/pdf'
              : undefined,
          byteSize: integer(sdsRecord, 'byteSize', 'byte_size') || undefined,
          configurationRevision:
            integer(sdsRecord, 'configurationRevision', 'configuration_revision') || undefined,
          configurationHash:
            text(sdsRecord, 'configurationHash', 'configuration_hash') || undefined,
          baselineId: text(sdsRecord, 'baselineId', 'baseline_id') || undefined,
          baselineHash: text(sdsRecord, 'baselineHash', 'baseline_hash') || undefined,
          offlineStatus: 'not_cached',
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
  const fieldVisitReferences: Record<string, LiveFieldVisitReference> = Object.fromEntries(
    visitRows.flatMap((visit) => {
      const visitId = text(visit, 'id');
      const jobId = text(visit, 'job_id', 'jobId');
      const job = jobById.get(jobId);
      const packet = fieldPacketByVisitId.get(visitId);
      if (!job || !packet) return [];
      const propertyId = text(job, 'propertyId', 'property_id');
      if (
        text(packet, 'visitId', 'visit_id') !== visitId ||
        text(packet, 'jobId', 'job_id') !== jobId ||
        text(packet, 'propertyId', 'property_id') !== propertyId ||
        integer(packet, 'visitVersion', 'visit_version') !== integer(visit, 'version')
      ) {
        throw new Error(
          'A role-visible field packet did not match its visit, job, property, and version.',
        );
      }
      const activeEntry = timeRows.find(
        (entry) =>
          text(entry, 'visit_id', 'visitId') === visitId && !text(entry, 'ended_at', 'endedAt'),
      );
      const packetChecklistItems = Object.fromEntries(
        Object.entries(allChecklistReferences).filter(
          ([, reference]) => reference.visitId === visitId,
        ),
      );
      const visitOnMyWayDelivery = mapTransactionalDelivery(
        transactionalDeliveryRows.find(
          (attempt) =>
            text(attempt, 'action') === 'visit.on_my_way' &&
            text(attempt, 'entityId', 'entity_id') === visitId,
        ),
      );
      return [
        [
          visitId,
          {
            visit: { id: visitId, version: integer(visit, 'version') },
            visitStatus: text(visit, 'status'),
            visitStartsAt: text(visit, 'starts_at', 'startsAt') || undefined,
            visitEndsAt: text(visit, 'ends_at', 'endsAt') || undefined,
            job: { id: jobId, version: integer(job, 'version') },
            jobId,
            jobStatus: text(job, 'status') || undefined,
            jobEstimatedDurationMinutes:
              integer(job, 'estimatedDurationMinutes', 'estimated_duration_minutes') || undefined,
            jobAssignedCrewId: text(job, 'assignedCrewId', 'assigned_crew_id') || undefined,
            customerId: text(job, 'customerId', 'customer_id') || undefined,
            propertyId,
            activeTimeEntry: activeEntry
              ? {
                  id: text(activeEntry, 'id'),
                  version: integer(activeEntry, 'version'),
                }
              : undefined,
            checklistItems: packetChecklistItems,
            onMyWayDelivery: visitOnMyWayDelivery,
          } satisfies LiveFieldVisitReference,
        ] as const,
      ];
    }),
  );
  const readyToScheduleJobs: LiveDispatchJobReference[] =
    role === 'owner' || role === 'dispatcher'
      ? jobRows
          .filter((job) => text(job, 'status') === 'ready_to_schedule')
          .map((job) => {
            const customer = customerById.get(text(job, 'customerId', 'customer_id'));
            const property = propertyById.get(text(job, 'propertyId', 'property_id'));
            return {
              id: text(job, 'id'),
              version: integer(job, 'version'),
              jobNumber: text(job, 'jobNumber', 'job_number') || 'Unnumbered job',
              customerName:
                text(customer ?? {}, 'display_name', 'displayName') || 'Customer not projected',
              propertyAddress: serviceAddress(property),
              estimatedDurationMinutes: integer(
                job,
                'estimatedDurationMinutes',
                'estimated_duration_minutes',
              ),
              assignedCrewId: text(job, 'assignedCrewId', 'assigned_crew_id') || undefined,
            };
          })
      : [];
  const selectedDispatchJobId = selectReadyDispatchJobId(
    readyToScheduleJobs.map((job) => ({ id: job.id, status: 'ready_to_schedule' })),
    selection.selectedDispatchJobId,
  );
  const dispatchJob = readyToScheduleJobs.find((job) => job.id === selectedDispatchJobId);
  const primaryVisit = visitRows.find((visit) => text(visit, 'id') === selectedVisitId);
  const primaryVisitId = text(primaryVisit ?? {}, 'id');
  const primaryVisitJobId = text(primaryVisit ?? {}, 'job_id', 'jobId');
  const primaryVisitJob = jobById.get(primaryVisitJobId);
  const selectedFieldReference = fieldVisitReferences[primaryVisitId];
  if (primaryVisit && !primaryVisitJob) {
    throw new Error('The selected role-visible visit did not include its exact job reference.');
  }
  const primaryJob = primaryVisit
    ? primaryVisitJob
    : (jobRows.find((job) => text(job, 'quoteId', 'quote_id') === text(primaryQuote ?? {}, 'id')) ??
      jobRows[0]);
  const matchingPrimaryInvoice = invoiceRows.find(
    (invoice) =>
      text(invoice, 'jobId', 'job_id') === text(primaryJob ?? {}, 'id') &&
      text(invoice, 'purpose') !== 'other',
  );
  const primaryInvoice = primaryVisit
    ? matchingPrimaryInvoice
    : (matchingPrimaryInvoice ?? invoiceRows[0]);
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
  const portalCustomer = workspace.customerPortal?.customers.find(
    (candidate) => candidate.customerId === selectedPortalCustomerId,
  );
  const liveQuote =
    role === 'customer' && portalCustomer?.commercial.quote
      ? asRecord(portalCustomer.commercial.quote)
      : (primaryQuote ?? {});
  const quoteDelivery = mapTransactionalDelivery(
    transactionalDeliveryRows.find(
      (attempt) =>
        text(attempt, 'action') === 'quote.delivery' &&
        text(attempt, 'entityId', 'entity_id') === text(liveQuote, 'id'),
    ),
  );
  const onMyWayDelivery = mapTransactionalDelivery(
    transactionalDeliveryRows.find(
      (attempt) =>
        text(attempt, 'action') === 'visit.on_my_way' &&
        text(attempt, 'entityId', 'entity_id') === primaryVisitId,
    ),
  );
  const quoteStatus = text(liveQuote, 'status');
  const depositRequired = number(liveQuote, 'depositRequired', 'deposit_required');
  const portalDepositEvidence = portalCustomer?.commercial.depositEvidence;
  const portalDepositReady =
    portalDepositEvidence?.quoteId === text(liveQuote, 'id') &&
    Number(portalDepositEvidence.required) === depositRequired &&
    Number(portalDepositEvidence.verified) >= depositRequired &&
    portalDepositEvidence.ready;
  const staffDepositEvidence = workspace.depositEvidence?.find(
    (evidence) =>
      evidence.quoteId === text(liveQuote, 'id') &&
      evidence.jobId === text(primaryJob ?? {}, 'id') &&
      evidence.invoiceId === text(primaryInvoice ?? {}, 'id'),
  );
  const staffDepositReady =
    staffDepositEvidence?.providerProof === true &&
    Boolean(staffDepositEvidence.paymentId) &&
    Number(staffDepositEvidence.required) === depositRequired &&
    Number(staffDepositEvidence.verified) >= depositRequired &&
    staffDepositEvidence.ready;
  const customerQuoteChangeRequests = records(workspace, 'customerQuoteChangeRequests').map(
    (request) => ({
      id: text(request, 'id'),
      customerId: text(request, 'customerId', 'customer_id'),
      propertyId: text(request, 'propertyId', 'property_id'),
      quoteId: text(request, 'quoteId', 'quote_id'),
      quoteNumber: text(request, 'quoteNumber', 'quote_number'),
      quoteVersion: integer(request, 'quoteVersion', 'quote_version'),
      requestedServiceCodes: stringList(
        request,
        'requestedServiceCodes',
        'requested_service_codes',
      ),
      requestedAddOnCodes: stringList(request, 'requestedAddOnCodes', 'requested_add_on_codes'),
      requestNotes: text(request, 'requestNotes', 'request_notes'),
      status:
        text(request, 'status') === 'reviewing' ? ('reviewing' as const) : ('submitted' as const),
      createdAt: text(request, 'createdAt', 'created_at'),
      version: integer(request, 'version'),
      nextAction: text(request, 'nextAction', 'next_action'),
    }),
  );
  const paymentAllocationConflicts = records(workspace, 'paymentAllocationConflicts').map(
    (conflict) => ({
      id: text(conflict, 'id'),
      paymentId: text(conflict, 'paymentId', 'payment_id'),
      invoiceId: text(conflict, 'invoiceId', 'invoice_id'),
      invoiceNumber: text(conflict, 'invoiceNumber', 'invoice_number'),
      customerId: text(conflict, 'customerId', 'customer_id'),
      providerEventId: text(conflict, 'providerEventId', 'provider_event_id'),
      conflictCode: text(conflict, 'conflictCode', 'conflict_code') as
        | 'stale_invoice_version'
        | 'invoice_not_payable'
        | 'provider_overpayment'
        | 'provider_underpayment'
        | 'local_payment_amount_mismatch'
        | 'retired_checkout_succeeded',
      intendedAmount: text(conflict, 'intendedAmount', 'intended_amount'),
      verifiedAmount: text(conflict, 'verifiedAmount', 'verified_amount'),
      invoiceBalanceAtEvent: text(conflict, 'invoiceBalanceAtEvent', 'invoice_balance_at_event'),
      providerCheckoutId: text(conflict, 'providerCheckoutId', 'provider_checkout_id') || undefined,
      providerPaymentId: text(conflict, 'providerPaymentId', 'provider_payment_id'),
      providerOccurredAt: text(conflict, 'providerOccurredAt', 'provider_occurred_at'),
      approvalRequestId: text(conflict, 'approvalRequestId', 'approval_request_id') || undefined,
      status: 'open' as const,
      createdAt: text(conflict, 'createdAt', 'created_at'),
      version: integer(conflict, 'version'),
      resolutionAction: text(conflict, 'resolutionAction', 'resolution_action') as
        'payment.allocation.apply_exact_current_balance' | 'payment.allocation.review_manual',
      canApplyExactCurrentBalance:
        conflict.canApplyExactCurrentBalance === true ||
        conflict.can_apply_exact_current_balance === true,
      nextAction: text(conflict, 'nextAction', 'next_action'),
    }),
  );
  const recurringDueWork =
    role === 'customer' && workspace.recurringDueWork
      ? {
          ...workspace.recurringDueWork,
          plans: workspace.recurringDueWork.plans.filter(
            (plan) => plan.customerId === selectedPortalCustomerId,
          ),
          workItems: workspace.recurringDueWork.workItems.filter(
            (item) => item.customerId === selectedPortalCustomerId,
          ),
        }
      : workspace.recurringDueWork;
  const base = createDemoState();

  return {
    ...base,
    hydrated: true,
    dataMode: 'supabase',
    authStatus: 'signed_in',
    liveError: undefined,
    serverVerifiedAt: workspace.serverTime,
    setupComplete: true,
    companyConfiguration: workspace.companyConfiguration,
    operatingBaseline: workspace.operatingBaseline,
    providerLaunch: workspace.providerLaunch,
    pilotReleaseEvidence: workspace.pilotReleaseEvidence,
    recurringDueWork,
    materialSdsRegistry: workspace.materialSdsRegistry,
    aiOfficeRecent: workspace.aiOfficeRecent,
    liveAuditFeed: workspace.auditFeed,
    role,
    online: navigator.onLine,
    syncRevision: 0,
    selectedLeadId: leads[0]?.id ?? '',
    selectedVisitId,
    selectedDispatchJobId,
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
    customerPortalRequests: portalCustomer?.requests ?? [],
    customerCommunicationPreferences:
      portalCustomer?.preferences ?? base.customerCommunicationPreferences,
    customerPortalServiceOptions: portalCustomer?.serviceOptions ?? [],
    customerQuoteAccepted: quoteStatus === 'accepted',
    depositPaid:
      depositRequired === 0 || portalDepositReady || (role !== 'customer' && staffDepositReady),
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
      portalAccounts,
      selectedPortalCustomerId,
      serverTime: workspace.serverTime,
      profitabilityKpis: workspace.profitabilityKpis,
      quote: text(liveQuote, 'id')
        ? {
            id: text(liveQuote, 'id'),
            version: integer(liveQuote, 'version'),
          }
        : undefined,
      quoteStatus: text(liveQuote, 'status') || undefined,
      quoteTermsSnapshot:
        typeof liveQuote.termsSnapshot === 'string'
          ? liveQuote.termsSnapshot
          : liveQuote.termsSnapshot
            ? JSON.stringify(liveQuote.termsSnapshot)
            : undefined,
      quoteDelivery,
      visit: primaryVisit
        ? {
            id: primaryVisitId,
            version: integer(primaryVisit, 'version'),
          }
        : undefined,
      fieldPacketVisitId: selectedFieldReference ? primaryVisitId : undefined,
      visitStatus:
        selectedFieldReference?.visitStatus || text(primaryVisit ?? {}, 'status') || undefined,
      visitStartsAt:
        selectedFieldReference?.visitStartsAt ||
        text(primaryVisit ?? {}, 'starts_at', 'startsAt') ||
        undefined,
      visitEndsAt:
        selectedFieldReference?.visitEndsAt ||
        text(primaryVisit ?? {}, 'ends_at', 'endsAt') ||
        undefined,
      onMyWayDelivery,
      fieldVisitReferences,
      readyToScheduleJobs,
      dispatchJob,
      job:
        selectedFieldReference?.job ??
        (primaryJob
          ? {
              id: text(primaryJob, 'id'),
              version: integer(primaryJob, 'version'),
            }
          : undefined),
      jobStatus: selectedFieldReference?.jobStatus || text(primaryJob ?? {}, 'status') || undefined,
      jobId: selectedFieldReference?.jobId || text(primaryJob ?? {}, 'id') || undefined,
      jobEstimatedDurationMinutes:
        selectedFieldReference?.jobEstimatedDurationMinutes ||
        integer(primaryJob ?? {}, 'estimatedDurationMinutes', 'estimated_duration_minutes') ||
        undefined,
      jobAssignedCrewId:
        selectedFieldReference?.jobAssignedCrewId ||
        text(primaryJob ?? {}, 'assignedCrewId', 'assigned_crew_id') ||
        undefined,
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
        selectedFieldReference?.customerId ||
        text(primaryJob ?? {}, 'customerId', 'customer_id') ||
        (role === 'customer' ? text(customerRows[0] ?? {}, 'id') : undefined),
      propertyId:
        selectedFieldReference?.propertyId ||
        text(primaryJob ?? {}, 'propertyId', 'property_id') ||
        (role === 'customer' ? text(propertyRows[0] ?? {}, 'id') : undefined),
      activeTimeEntry:
        selectedFieldReference?.activeTimeEntry ??
        (activeTime
          ? { id: text(activeTime, 'id'), version: integer(activeTime, 'version') }
          : undefined),
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
      customerCommercialPortal: portalCustomer?.commercial,
      customerCompletedWork: portalCustomer?.completedWork,
      customerQuoteChangeRequests,
      paymentAllocationConflicts,
      customers: customerSummaries,
      properties: propertyRows.map((property) => {
        const candidateId = text(property, 'geocode_candidate_id', 'geocodeCandidateId');
        const provider = text(property, 'geocode_provider', 'geocodeProvider');
        const precision = text(property, 'geocode_precision', 'geocodePrecision');
        const confidence = optionalNumber(property, 'geocode_confidence', 'geocodeConfidence');
        const geocodedAt = text(property, 'geocoded_at', 'geocodedAt');
        const confirmed =
          candidateId.length > 0 &&
          provider === 'google_maps' &&
          ['rooftop', 'parcel', 'street'].includes(precision) &&
          confidence !== undefined &&
          confidence >= 0.8 &&
          geocodedAt.length > 0;
        return {
          id: text(property, 'id'),
          customerId: text(property, 'customer_id', 'customerId'),
          name: text(property, 'name') || 'Unnamed property',
          address: serviceAddress(property),
          version: integer(property, 'version'),
          geocodeReviewStatus: confirmed ? ('confirmed' as const) : ('review_required' as const),
          ...(confirmed
            ? {
                geocodeProvider: 'google_maps' as const,
                geocodePrecision: precision as 'rooftop' | 'parcel' | 'street',
                geocodeConfidence: confidence,
                geocodedAt,
              }
            : {}),
        };
      }),
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

export function createCompanyControlRecoveryState(
  controlState: CompanyControlState,
  error?: string,
  preservedOfflineQueue: readonly OfflineMutation[] = [],
): DemoState {
  if (controlState.status === 'setup') {
    throw new Error('Setup companies must use the finite setup and publication workflow.');
  }
  const base = createSignedOutLiveState();
  return {
    ...base,
    authStatus: 'signed_in',
    setupComplete: true,
    role: 'owner',
    online: true,
    serverVerifiedAt: controlState.serverTime,
    liveError: error,
    companyControlState: controlState,
    companyControlRecovery: true,
    offlineQueue: [...preservedOfflineQueue],
    live: {
      userId: controlState.userId,
      companyId: controlState.companyId,
      companyName: controlState.companyName,
      companyTimezone: controlState.timezone,
      serverTime: controlState.serverTime,
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
      paymentAllocationConflicts: [],
      fieldVisitReferences: {},
      readyToScheduleJobs: [],
    },
  };
}

export function createPausedCompanyRecoveryState(
  controlState: CompanyControlState,
  error?: string,
  preservedOfflineQueue: readonly OfflineMutation[] = [],
): DemoState {
  if (controlState.status !== 'paused' || !controlState.canReactivate) {
    throw new Error('Only a server-confirmed paused company can open owner recovery.');
  }
  return createCompanyControlRecoveryState(controlState, error, preservedOfflineQueue);
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
      paymentAllocationConflicts: [],
      fieldVisitReferences: {},
      readyToScheduleJobs: [],
    },
  };
}
