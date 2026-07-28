import {
  postServiceRequestSchema,
  postServiceResponseSchema,
  postServiceStatusSchema,
} from './contracts.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) throw new Error(message);
}

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const COMMAND_ID = '98000000-0000-4000-8000-000000000001';
const INVOICE_ID = '10000000-0000-4000-8000-000000000651';
const JOB_ID = '10000000-0000-4000-8000-000000000631';
const RECORD_ID = '98000000-0000-4000-8000-000000000002';

Deno.test('communication requests accept only finite identifiers and channel', () => {
  assert(
    postServiceRequestSchema.safeParse({
      companyId: COMPANY_ID,
      action: 'review.request',
      commandId: COMMAND_ID,
      invoiceId: INVOICE_ID,
      expectedVersion: 3,
      channel: 'email',
    }).success,
  );
  assert(
    !postServiceRequestSchema.safeParse({
      companyId: COMPANY_ID,
      action: 'review.request',
      commandId: COMMAND_ID,
      invoiceId: INVOICE_ID,
      expectedVersion: 3,
      channel: 'email',
      delivered: true,
    }).success,
  );
  assert(
    !postServiceRequestSchema.safeParse({
      companyId: COMPANY_ID,
      action: 'referral.invite',
      commandId: COMMAND_ID,
      invoiceId: INVOICE_ID,
      expectedVersion: 3,
      channel: 'voice',
    }).success,
  );
});

Deno.test('maintenance cadence contract requires explicit valid next service intent', () => {
  assert(
    postServiceRequestSchema.safeParse({
      companyId: COMPANY_ID,
      action: 'maintenance.activate',
      commandId: COMMAND_ID,
      invoiceId: INVOICE_ID,
      expectedVersion: 3,
      cadence: 'semiannual',
      nextDueDate: '2027-01-28',
    }).success,
  );
  assert(
    !postServiceRequestSchema.safeParse({
      companyId: COMPANY_ID,
      action: 'maintenance.activate',
      commandId: COMMAND_ID,
      invoiceId: INVOICE_ID,
      expectedVersion: 3,
      cadence: 'custom',
      nextDueDate: '2027-01-28',
    }).success,
  );
  assert(
    !postServiceRequestSchema.safeParse({
      companyId: COMPANY_ID,
      action: 'maintenance.activate',
      commandId: COMMAND_ID,
      invoiceId: INVOICE_ID,
      expectedVersion: 3,
      cadence: 'annual',
      intervalDays: 365,
      nextDueDate: '2027-02-30',
    }).success,
  );
});

Deno.test('queued response cannot claim provider delivery', () => {
  const parsed = postServiceResponseSchema.safeParse({
    schemaVersion: 'storyops-post-service-v1',
    companyId: COMPANY_ID,
    action: 'review.request',
    commandId: COMMAND_ID,
    invoiceId: INVOICE_ID,
    invoiceVersion: 3,
    jobId: JOB_ID,
    recordId: RECORD_ID,
    domainRecordId: RECORD_ID,
    status: 'queued',
    channel: 'email',
    scheduledAt: '2026-07-28T20:00:00Z',
    replayed: false,
    alreadyExisted: false,
    requestHash: 'a'.repeat(64),
    serverTime: '2026-07-28T18:00:00Z',
  });
  assert(parsed.success);
  assert(
    !postServiceResponseSchema.safeParse({
      ...parsed.data,
      providerMessageId: 'message_not_allowed',
      delivered: true,
    }).success,
  );
});

Deno.test('maintenance response and role projection require fresh-estimate truth', () => {
  assert(
    postServiceResponseSchema.safeParse({
      schemaVersion: 'storyops-post-service-v1',
      companyId: COMPANY_ID,
      action: 'maintenance.activate',
      commandId: COMMAND_ID,
      invoiceId: INVOICE_ID,
      invoiceVersion: 3,
      jobId: JOB_ID,
      recordId: RECORD_ID,
      domainRecordId: RECORD_ID,
      status: 'active',
      cadence: 'annual',
      nextDueDate: '2027-07-28',
      requiresFreshEstimate: true,
      replayed: false,
      alreadyExisted: false,
      requestHash: 'b'.repeat(64),
      serverTime: '2026-07-28T18:00:00Z',
    }).success,
  );
  assert(
    postServiceStatusSchema.safeParse({
      schemaVersion: 'storyops-post-service-status-v1',
      companyId: COMPANY_ID,
      serverTime: '2026-07-28T18:00:00Z',
      followups: [
        {
          id: RECORD_ID,
          invoiceId: INVOICE_ID,
          jobId: JOB_ID,
          customerId: '10000000-0000-4000-8000-000000000201',
          propertyId: '10000000-0000-4000-8000-000000000211',
          action: 'review.request',
          domainRecordId: RECORD_ID,
          channel: 'sms',
          status: 'submitted_unknown',
          scheduledAt: '2026-07-28T18:00:00Z',
          providerMode: 'live',
          providerStatus: 'submission_unknown',
          manualReconciliationRequired: true,
          externalDeliveryClaimed: false,
          version: 1,
        },
        {
          id: '10000000-0000-4000-8000-000000000662',
          invoiceId: INVOICE_ID,
          jobId: JOB_ID,
          customerId: '10000000-0000-4000-8000-000000000201',
          propertyId: '10000000-0000-4000-8000-000000000211',
          action: 'referral.invite',
          domainRecordId: '10000000-0000-4000-8000-000000000672',
          channel: 'sms',
          status: 'reconciliation_required',
          scheduledAt: '2026-07-28T18:00:00Z',
          providerMode: 'live',
          providerStatus: 'queued',
          manualReconciliationRequired: true,
          externalDeliveryClaimed: false,
          version: 1,
        },
      ],
      maintenancePlans: [
        {
          id: RECORD_ID,
          invoiceId: INVOICE_ID,
          jobId: JOB_ID,
          customerId: '10000000-0000-4000-8000-000000000201',
          propertyId: '10000000-0000-4000-8000-000000000211',
          status: 'active',
          cadence: 'annual',
          nextDueDate: '2027-07-28',
          serviceCodes: ['pressure-wash-flatwork'],
          requiresFreshEstimate: true,
          version: 1,
        },
      ],
    }).success,
  );
});
