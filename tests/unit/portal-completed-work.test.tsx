import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from '@/state/demoSeed';
import type { DemoState, StoryOpsActions } from '@/state/model';

const mocked = vi.hoisted(() => ({
  value: undefined as
    | {
        state: DemoState;
        actions: StoryOpsActions;
        can: () => boolean;
      }
    | undefined,
}));

vi.mock('@/state/StoryOpsProvider', () => ({
  useStoryOps: () => {
    if (!mocked.value) throw new Error('Test WashOps context was not initialized.');
    return mocked.value;
  },
}));

vi.mock('@/router', () => ({
  useNavigate: () => vi.fn(),
}));

import { PortalPage } from '@/pages/PortalPage';

const companyId = '10000000-0000-4000-8000-000000000001';
const customerId = '10000000-0000-4000-8000-000000000201';
const propertyId = '10000000-0000-4000-8000-000000000211';
const quoteId = '10000000-0000-4000-8000-000000000221';
const estimateId = '10000000-0000-4000-8000-000000000231';
const jobId = '10000000-0000-4000-8000-000000000631';
const visitId = '10000000-0000-4000-8000-000000000641';
const mediaId = '10000000-0000-4000-8000-000000000651';

function acceptedLivePortalState(depositRequired: string, depositPaid: boolean): DemoState {
  const base = createDemoState();
  return {
    ...base,
    dataMode: 'supabase',
    authStatus: 'signed_in',
    role: 'customer',
    online: true,
    serverVerifiedAt: '2026-07-30T12:00:00.000Z',
    customerQuoteAccepted: true,
    depositPaid,
    estimate: {
      ...base.estimate,
      deposit: depositRequired,
    },
    visits: [],
    invoices: [],
    live: {
      userId: '10000000-0000-4000-8000-000000000104',
      companyId,
      companyName: 'Live Exterior Co',
      companyTimezone: 'America/Chicago',
      serverTime: '2026-07-30T12:00:00.000Z',
      customerId,
      selectedPortalCustomerId: customerId,
      portalAccounts: [{ customerId, displayName: 'A Customer' }],
      quote: { id: quoteId, version: 4 },
      invoiceVersions: {},
      leadVersions: {},
      checklistItems: {},
      checklistDefinitions: {},
      incidentVersions: {},
      notificationVersions: {},
      approvalVersions: {},
      materials: [],
      customers: [
        {
          id: customerId,
          name: 'A Customer',
          email: 'customer@example.com',
          phone: '555-0100',
          properties: 1,
          address: '100 Main Street',
          lifetime: '$0.00',
          lastService: 'No completed work',
          nextDue: 'No recurring due date',
          status: 'Active',
        },
      ],
      properties: [],
      customerCommercialPortal: {
        quote: {
          id: quoteId,
          quoteNumber: 'Q-1001',
          estimateId,
          propertyId,
          status: 'accepted',
          validUntil: '2026-08-30',
          termsVersion: 'terms-v1',
          termsSnapshot: 'Exact retained terms.',
          total: '250.00',
          depositRequired,
          portalPublishedAt: '2026-07-30T11:00:00.000Z',
          deliveryStatus: 'not_asserted',
          acceptedAt: '2026-07-30T11:05:00.000Z',
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
        invoices: [],
        paymentReconciliationRequired: false,
      },
    },
  };
}

afterEach(() => {
  mocked.value = undefined;
  vi.restoreAllMocks();
});

describe('authenticated customer completed-work evidence', () => {
  it('labels a zero-deposit quote without claiming that a payment occurred', () => {
    mocked.value = {
      state: acceptedLivePortalState('0.00', true),
      actions: {
        markQuoteViewed: vi.fn(),
        startDepositCheckout: vi.fn(),
      } as unknown as StoryOpsActions,
      can: () => false,
    };

    render(<PortalPage />);

    expect(screen.getByRole('heading', { name: 'No deposit required' })).toBeVisible();
    expect(
      screen.getByText(
        'This accepted quote requires no deposit. Scheduling readiness does not assert that a payment occurred.',
      ),
    ).toBeVisible();
    expect(screen.queryByText('Provider verified')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open secure checkout' })).not.toBeInTheDocument();
  });

  it('reserves provider-verified copy for a positive deposit with exact provider proof', () => {
    mocked.value = {
      state: acceptedLivePortalState('50.00', true),
      actions: {
        markQuoteViewed: vi.fn(),
        startDepositCheckout: vi.fn(),
      } as unknown as StoryOpsActions,
      can: () => false,
    };

    render(<PortalPage />);

    expect(screen.getByText('Provider verified')).toBeVisible();
    expect(screen.getByRole('heading', { name: '$50.00 deposit' })).toBeVisible();
    expect(
      screen.getByText('A signed provider event was reconciled before scheduling readiness.'),
    ).toBeVisible();
  });

  it('shows only projected evidence metadata and loads private bytes on demand', async () => {
    const base = createDemoState();
    const loadCustomerEvidence = vi
      .fn()
      .mockResolvedValue(new Blob(['jpg'], { type: 'image/jpeg' }));
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:completed-work');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const state: DemoState = {
      ...base,
      dataMode: 'supabase',
      authStatus: 'signed_in',
      role: 'customer',
      online: true,
      serverVerifiedAt: '2026-07-29T12:00:00.000Z',
      visits: [],
      invoices: [],
      live: {
        userId: '10000000-0000-4000-8000-000000000104',
        companyId,
        companyName: 'Live Exterior Co',
        companyTimezone: 'America/Chicago',
        serverTime: '2026-07-29T12:00:00.000Z',
        customerId,
        selectedPortalCustomerId: customerId,
        portalAccounts: [{ customerId, displayName: 'A Customer' }],
        invoiceVersions: {},
        leadVersions: {},
        checklistItems: {},
        checklistDefinitions: {},
        incidentVersions: {},
        notificationVersions: {},
        approvalVersions: {},
        materials: [],
        customers: [
          {
            id: customerId,
            name: 'A Customer',
            email: 'customer@example.com',
            phone: '555-0100',
            properties: 1,
            address: '100 Main Street',
            lifetime: '$250.00',
            lastService: '2026-07-28',
            nextDue: 'No recurring due date',
            status: 'Active',
          },
        ],
        properties: [],
        customerCompletedWork: [
          {
            visitId,
            jobId,
            jobNumber: 'JOB-1048',
            propertyId,
            serviceCodes: ['gutter-cleaning'],
            completedAt: '2026-07-28T18:00:00.000Z',
            media: [
              {
                id: mediaId,
                visitId,
                jobId,
                purpose: 'before',
                objectPath: `${companyId}/visits/${visitId}/${mediaId}-before.jpg`,
                contentType: 'image/jpeg',
                byteSize: 3,
                checksumSha256: 'a'.repeat(64),
                capturedAt: '2026-07-28T15:00:00.000Z',
                version: 2,
              },
            ],
          },
        ],
      },
    };
    mocked.value = {
      state,
      actions: {
        loadCustomerEvidence,
        markQuoteViewed: vi.fn(),
      } as unknown as StoryOpsActions,
      can: () => false,
    };

    render(<PortalPage />);

    expect(screen.getByRole('heading', { name: 'Completed work evidence' })).toBeVisible();
    expect(screen.getByText('JOB-1048')).toBeVisible();
    expect(screen.queryByText(/job-media/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View before photo' }));

    expect(await screen.findByAltText('before evidence for job JOB-1048')).toHaveAttribute(
      'src',
      'blob:completed-work',
    );
    expect(loadCustomerEvidence).toHaveBeenCalledWith(mediaId);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
  });

  it('keeps all same-account invoices actionable and exposes an explicit account switch', () => {
    const base = createDemoState();
    const secondCustomerId = '10000000-0000-4000-8000-000000000202';
    const paidInvoiceId = '10000000-0000-4000-8000-000000000701';
    const openInvoiceId = '10000000-0000-4000-8000-000000000702';
    const startInvoiceCheckout = vi.fn();
    const selectCustomerPortalAccount = vi.fn().mockResolvedValue(true);
    const state: DemoState = {
      ...base,
      dataMode: 'supabase',
      authStatus: 'signed_in',
      role: 'customer',
      online: true,
      serverVerifiedAt: '2026-07-29T12:00:00.000Z',
      visits: [],
      invoices: [
        {
          id: paidInvoiceId,
          number: 'INV-PAID',
          customerName: 'A Customer',
          jobNumber: 'JOB-1',
          issueDate: '2026-07-29',
          dueDate: '2026-08-12',
          total: '80.00',
          paid: '80.00',
          balance: '0.00',
          status: 'paid',
        },
        {
          id: openInvoiceId,
          number: 'INV-OPEN',
          customerName: 'A Customer',
          jobNumber: 'JOB-2',
          issueDate: '2026-07-01',
          dueDate: '2026-07-15',
          total: '200.00',
          paid: '0.00',
          balance: '200.00',
          status: 'past_due',
        },
      ],
      live: {
        userId: '10000000-0000-4000-8000-000000000104',
        companyId,
        companyName: 'Live Exterior Co',
        companyTimezone: 'America/Chicago',
        serverTime: '2026-07-29T12:00:00.000Z',
        customerId,
        selectedPortalCustomerId: customerId,
        portalAccounts: [
          { customerId, displayName: 'A Customer' },
          { customerId: secondCustomerId, displayName: 'Second Account' },
        ],
        invoiceVersions: { [paidInvoiceId]: 2, [openInvoiceId]: 4 },
        leadVersions: {},
        checklistItems: {},
        checklistDefinitions: {},
        incidentVersions: {},
        notificationVersions: {},
        approvalVersions: {},
        materials: [],
        customers: [
          {
            id: customerId,
            name: 'A Customer',
            email: 'customer@example.com',
            phone: '555-0100',
            properties: 1,
            address: '100 Main Street',
            lifetime: '$80.00',
            lastService: '2026-07-28',
            nextDue: 'No recurring due date',
            status: 'Active',
          },
        ],
        properties: [],
        customerCommercialPortal: {
          addOnOptions: [],
          changeRequests: [],
          invoices: [
            {
              id: paidInvoiceId,
              invoiceNumber: 'INV-PAID',
              jobId,
              status: 'paid',
              issueDate: '2026-07-29',
              dueDate: '2026-08-12',
              total: '80.00',
              amountPaid: '80.00',
              balanceDue: '0.00',
              version: 2,
              paymentReconciliationRequired: false,
            },
            {
              id: openInvoiceId,
              invoiceNumber: 'INV-OPEN',
              jobId,
              status: 'past_due',
              issueDate: '2026-07-01',
              dueDate: '2026-07-15',
              total: '200.00',
              amountPaid: '0.00',
              balanceDue: '200.00',
              version: 4,
              paymentReconciliationRequired: false,
            },
          ],
          paymentReconciliationRequired: false,
        },
      },
    };
    mocked.value = {
      state,
      actions: {
        markQuoteViewed: vi.fn(),
        startInvoiceCheckout,
        selectCustomerPortalAccount,
      } as unknown as StoryOpsActions,
      can: () => false,
    };

    render(<PortalPage />);

    expect(screen.getByRole('heading', { name: 'INV-PAID' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'INV-OPEN' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Pay $200.00 securely' }));
    expect(startInvoiceCheckout).toHaveBeenCalledWith(openInvoiceId);

    fireEvent.change(screen.getByLabelText('Customer account'), {
      target: { value: secondCustomerId },
    });
    expect(selectCustomerPortalAccount).toHaveBeenCalledWith(secondCustomerId);
  });
});
