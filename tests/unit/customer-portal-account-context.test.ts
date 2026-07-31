import { describe, expect, it } from 'vitest';
import { mapLiveWorkspace } from '@/state/liveWorkspaceMapper';
import type { LiveWorkspace } from '@/state/liveRepository';

const companyId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const customerA = '10000000-0000-4000-8000-000000000101';
const customerB = '10000000-0000-4000-8000-000000000102';
const propertyA = '10000000-0000-4000-8000-000000000201';
const propertyB = '10000000-0000-4000-8000-000000000202';
const quoteA = '10000000-0000-4000-8000-000000000301';
const quoteB = '10000000-0000-4000-8000-000000000302';
const estimateA = '10000000-0000-4000-8000-000000000311';
const estimateB = '10000000-0000-4000-8000-000000000312';
const jobA = '10000000-0000-4000-8000-000000000401';
const jobB = '10000000-0000-4000-8000-000000000402';
const visitA = '10000000-0000-4000-8000-000000000501';
const visitB = '10000000-0000-4000-8000-000000000502';
const invoiceAOpen = '10000000-0000-4000-8000-000000000601';
const invoiceAPaid = '10000000-0000-4000-8000-000000000602';
const invoiceB = '10000000-0000-4000-8000-000000000603';

function commercial(
  customerId: string,
  propertyId: string,
  quoteId: string,
  estimateId: string,
  invoiceIds: string[],
) {
  return {
    customerId,
    requests: [],
    preferences: {
      customerId,
      transactionalSms: true,
      transactionalEmail: true,
      marketingSms: false,
      marketingEmail: false,
      globalOptOut: false,
      disclosureVersion: 'customer-portal-consent-v1',
      version: 1,
    },
    serviceOptions: [],
    commercial: {
      quote: {
        id: quoteId,
        quoteNumber: `Q-${quoteId.slice(-3)}`,
        estimateId,
        propertyId,
        status: 'accepted' as const,
        validUntil: '2026-08-30',
        termsVersion: 'terms-v1',
        termsSnapshot: 'Exact retained terms.',
        total: '250.00',
        depositRequired: '50.00',
        portalPublishedAt: '2026-07-30T12:00:00.000Z',
        deliveryStatus: 'not_asserted' as const,
        acceptedAt: '2026-07-30T12:05:00.000Z',
        version: 4,
        lines: [
          {
            lineKind: 'service',
            description: 'Exterior cleaning',
            quantity: '1',
            unit: 'job',
            subtotal: '250.00',
            sortOrder: 0,
          },
        ],
      },
      addOnOptions: [],
      changeRequests: [],
      invoices: invoiceIds.map((id, index) => ({
        id,
        invoiceNumber: `INV-${id.slice(-3)}`,
        jobId: customerId === customerA ? jobA : jobB,
        status: index === 1 ? ('paid' as const) : ('open' as const),
        issueDate: '2026-07-30',
        dueDate: '2026-08-15',
        total: index === 1 ? '80.00' : '200.00',
        amountPaid: index === 1 ? '80.00' : '0.00',
        balanceDue: index === 1 ? '0.00' : '200.00',
        version: 2,
        paymentReconciliationRequired: false,
      })),
      paymentReconciliationRequired: false,
      depositEvidence: {
        quoteId,
        required: '50.00',
        verified: '0.00',
        ready: false,
      },
    },
    completedWork: [],
  };
}

function workspace(): LiveWorkspace {
  return {
    schemaVersion: 'storyops-workspace-v1',
    serverTime: '2026-07-30T12:10:00.000Z',
    session: { userId, companyId, role: 'customer' },
    company: {
      id: companyId,
      name: 'Live Exterior Co',
      timezone: 'America/Chicago',
      currency: 'USD',
      status: 'active',
      settings: {},
      version: 1,
    },
    // Deliberately non-deterministic source order.
    customers: [
      { id: customerB, displayName: 'Beta Property Group' },
      { id: customerA, displayName: 'Alice Home' },
    ],
    properties: [
      {
        id: propertyB,
        customerId: customerB,
        name: 'Beta property',
        serviceAddress: { line1: '200 Beta Street', city: 'Dallas', region: 'TX' },
      },
      {
        id: propertyA,
        customerId: customerA,
        name: 'Alice property',
        serviceAddress: { line1: '100 Alice Street', city: 'Dallas', region: 'TX' },
      },
    ],
    quotes: [
      {
        id: quoteB,
        propertyId: propertyB,
        quoteNumber: 'Q-B',
        status: 'accepted',
        total: '250.00',
        depositRequired: '50.00',
        version: 4,
      },
      {
        id: quoteA,
        propertyId: propertyA,
        quoteNumber: 'Q-A',
        status: 'accepted',
        total: '250.00',
        depositRequired: '50.00',
        version: 4,
      },
    ],
    jobs: [
      { id: jobB, propertyId: propertyB, jobNumber: 'JOB-B', version: 2 },
      { id: jobA, propertyId: propertyA, jobNumber: 'JOB-A', version: 2 },
    ],
    visits: [
      {
        id: visitB,
        jobId: jobB,
        status: 'confirmed',
        startsAt: '2026-08-02T14:00:00.000Z',
        endsAt: '2026-08-02T16:00:00.000Z',
        version: 2,
      },
      {
        id: visitA,
        jobId: jobA,
        status: 'confirmed',
        startsAt: '2026-08-01T14:00:00.000Z',
        endsAt: '2026-08-01T16:00:00.000Z',
        version: 2,
      },
    ],
    invoices: [
      {
        id: invoiceB,
        jobId: jobB,
        invoiceNumber: 'INV-B',
        status: 'open',
        total: '200.00',
        amountPaid: '0.00',
        balanceDue: '200.00',
        version: 2,
      },
      {
        id: invoiceAOpen,
        jobId: jobA,
        invoiceNumber: 'INV-A-OPEN',
        status: 'open',
        total: '200.00',
        amountPaid: '0.00',
        balanceDue: '200.00',
        version: 2,
      },
      {
        id: invoiceAPaid,
        jobId: jobA,
        invoiceNumber: 'INV-A-PAID',
        status: 'paid',
        total: '80.00',
        amountPaid: '80.00',
        balanceDue: '0.00',
        version: 2,
      },
    ],
    payments: [
      {
        id: '10000000-0000-4000-8000-000000000701',
        invoiceId: invoiceB,
        paymentType: 'deposit',
        status: 'succeeded',
        amount: '50.00',
      },
    ],
    customerPortal: {
      schemaVersion: 'storyops-customer-portal-state-v2',
      companyId,
      serverTime: '2026-07-30T12:10:00.000Z',
      customers: [
        commercial(customerB, propertyB, quoteB, estimateB, [invoiceB]),
        commercial(customerA, propertyA, quoteA, estimateA, [invoiceAOpen, invoiceAPaid]),
      ],
    },
  };
}

describe('customer portal account context', () => {
  it('chooses a stable account and scopes every actionable projection atomically', () => {
    const state = mapLiveWorkspace(workspace());

    expect(state.live?.portalAccounts).toEqual([
      { customerId: customerA, displayName: 'Alice Home' },
      { customerId: customerB, displayName: 'Beta Property Group' },
    ]);
    expect(state.live?.selectedPortalCustomerId).toBe(customerA);
    expect(state.live?.customerId).toBe(customerA);
    expect(state.live?.quote).toEqual({ id: quoteA, version: 4 });
    expect(state.live?.customerCommercialPortal?.quote?.id).toBe(quoteA);
    expect(state.live?.visit?.id).toBe(visitA);
    expect(state.live?.properties.map((property) => property.id)).toEqual([propertyA]);
    expect(state.invoices.map((invoice) => invoice.id)).toEqual([invoiceAOpen, invoiceAPaid]);
    expect(state.depositPaid).toBe(false);
  });

  it('switches quote, visit, invoices, and payment facts as one selected account', () => {
    const state = mapLiveWorkspace(workspace(), { portalCustomerId: customerB });

    expect(state.live?.selectedPortalCustomerId).toBe(customerB);
    expect(state.live?.customerId).toBe(customerB);
    expect(state.live?.quote).toEqual({ id: quoteB, version: 4 });
    expect(state.live?.customerCommercialPortal?.quote?.id).toBe(quoteB);
    expect(state.live?.visit?.id).toBe(visitB);
    expect(state.live?.properties.map((property) => property.id)).toEqual([propertyB]);
    expect(state.invoices.map((invoice) => invoice.id)).toEqual([invoiceB]);
    expect(state.depositPaid).toBe(false);
  });

  it('uses exact portal provider-proof evidence instead of invoice amount_paid', () => {
    const fixture = workspace();
    const account = fixture.customerPortal?.customers.find(
      (candidate) => candidate.customerId === customerA,
    );
    if (!account) throw new Error('Expected customer A fixture.');
    account.commercial.depositEvidence = {
      quoteId: quoteA,
      required: '50.00',
      verified: '50.00',
      ready: true,
    };

    const state = mapLiveWorkspace(fixture);
    expect(state.invoices.find((invoice) => invoice.id === invoiceAOpen)?.paid).toBe('0.00');
    expect(state.depositPaid).toBe(true);
  });

  it('rejects deposit evidence for a different quote in the selected account', () => {
    const fixture = workspace();
    const account = fixture.customerPortal?.customers.find(
      (candidate) => candidate.customerId === customerA,
    );
    if (!account) throw new Error('Expected customer A fixture.');
    account.commercial.depositEvidence = {
      quoteId: quoteB,
      required: '50.00',
      verified: '50.00',
      ready: true,
    };

    expect(mapLiveWorkspace(fixture).depositPaid).toBe(false);
  });

  it('uses the exact correlated staff proof projection and ignores raw succeeded status', () => {
    const fixture = workspace();
    fixture.session.role = 'owner';
    fixture.customerPortal = undefined;
    fixture.quotes = (fixture.quotes as Array<{ id: string }>).filter(
      (quote) => quote.id === quoteA,
    );
    fixture.jobs = (fixture.jobs as Array<{ id: string }>).filter((job) => job.id === jobA);
    fixture.visits = (fixture.visits as Array<{ id: string }>).filter(
      (visit) => visit.id === visitA,
    );
    fixture.invoices = (fixture.invoices as Array<{ id: string }>).filter(
      (invoice) => invoice.id === invoiceAOpen,
    );
    fixture.payments = [
      {
        id: '10000000-0000-4000-8000-000000000799',
        invoiceId: invoiceAOpen,
        paymentType: 'deposit',
        status: 'succeeded',
        amount: '50.00',
      },
    ];
    fixture.depositEvidence = [
      {
        quoteId: quoteA,
        jobId: jobA,
        invoiceId: invoiceAOpen,
        paymentId: '10000000-0000-4000-8000-000000000799',
        required: '50.00',
        verified: '50.00',
        providerProof: true,
        ready: true,
      },
    ];

    expect(mapLiveWorkspace(fixture).depositPaid).toBe(true);
    fixture.depositEvidence[0] = {
      quoteId: quoteA,
      jobId: jobA,
      invoiceId: invoiceB,
      paymentId: '10000000-0000-4000-8000-000000000799',
      required: '50.00',
      verified: '50.00',
      providerProof: true,
      ready: true,
    };
    expect(mapLiveWorkspace(fixture).depositPaid).toBe(false);
  });

  it('fails closed to a projected account when a stale selection is no longer mapped', () => {
    const staleCustomerId = '10000000-0000-4000-8000-000000000199';
    const state = mapLiveWorkspace(workspace(), { portalCustomerId: staleCustomerId });

    expect(state.live?.selectedPortalCustomerId).toBe(customerA);
    expect(state.live?.customerId).toBe(customerA);
    expect(state.live?.quote?.id).toBe(quoteA);
  });
});
