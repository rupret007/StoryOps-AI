import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomersPage } from '@/pages/CustomersPage';
import { MemoryRouter } from '@/router';
import { createDemoState } from '@/state/demoSeed';
import type { DemoState, StoryOpsActions } from '@/state/model';

const companyId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000101';
const customerId = '10000000-0000-4000-8000-000000000201';
const propertyId = '10000000-0000-4000-8000-000000000211';
const operationId = '94900000-0000-4000-8000-000000000001';
const candidateId = '94900000-0000-4000-8000-000000000002';

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
    if (!mocked.value) throw new Error('Test StoryOps context was not initialized.');
    return mocked.value;
  },
}));

function liveState(): DemoState {
  const base = createDemoState();
  return {
    ...base,
    dataMode: 'supabase',
    authStatus: 'signed_in',
    role: 'owner',
    online: true,
    serverVerifiedAt: '2026-07-30T15:00:00.000Z',
    live: {
      userId,
      companyId,
      companyName: 'Live Exterior Co',
      companyTimezone: 'America/Chicago',
      serverTime: '2026-07-30T15:00:00.000Z',
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
          name: 'Morgan Ellis',
          email: 'morgan@example.com',
          phone: '214-555-0100',
          properties: 1,
          address: '123 Main Street, Dallas, TX, 75201',
          lifetime: '$0.00',
          lastService: 'No completed service',
          nextDue: 'No recurring due date',
          status: 'Lead',
        },
      ],
      properties: [
        {
          id: propertyId,
          customerId,
          name: 'Primary property',
          address: '123 Main Street, Dallas, TX, 75201',
          version: 3,
          geocodeReviewStatus: 'review_required',
        },
      ],
    },
  };
}

afterEach(() => {
  mocked.value = undefined;
  vi.restoreAllMocks();
});

function renderCustomers(path = '/customers') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CustomersPage />
    </MemoryRouter>,
  );
}

describe('customer/property production workflow', () => {
  it('opens only the exact role-visible customer named by a search deep link', () => {
    mocked.value = {
      state: liveState(),
      actions: {} as StoryOpsActions,
      can: () => true,
    };
    renderCustomers(`/customers?customer=${customerId}`);

    expect(screen.getByRole('dialog', { name: 'Morgan Ellis' })).toBeVisible();
    expect(screen.queryByText(/not in the current role-visible workspace/iu)).toBeNull();
  });

  it('fails closed when a customer search target is no longer role-visible', () => {
    mocked.value = {
      state: liveState(),
      actions: {} as StoryOpsActions,
      can: () => true,
    };
    renderCustomers('/customers?customer=stale-customer-id');

    expect(screen.getByText(/not in the current role-visible workspace/iu)).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Morgan Ellis' })).toBeNull();
  });

  it('keeps the intake dialog open and claims no success when atomic creation is unconfirmed', async () => {
    const createCustomerProperty = vi.fn().mockResolvedValue(undefined);
    mocked.value = {
      state: liveState(),
      actions: { createCustomerProperty } as unknown as StoryOpsActions,
      can: () => true,
    };
    renderCustomers();

    fireEvent.click(screen.getByRole('button', { name: 'Add customer' }));
    fireEvent.change(screen.getByLabelText('Customer name'), {
      target: { value: 'Taylor Nguyen' },
    });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Plano' } });
    fireEvent.change(screen.getByLabelText('State / region'), { target: { value: 'TX' } });
    fireEvent.change(screen.getByLabelText('Postal code'), { target: { value: '75024' } });
    fireEvent.change(screen.getByLabelText('Service property'), {
      target: { value: '611 Stone Creek Drive' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create customer and property' }));

    expect(await screen.findByText(/no creation receipt was accepted/iu)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add a verified customer' })).toBeVisible();
    expect(createCustomerProperty).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'Taylor Nguyen',
        serviceAddress: expect.objectContaining({
          line1: '611 Stone Creek Drive',
          city: 'Plano',
          region: 'TX',
          postalCode: '75024',
        }),
      }),
    );
  });

  it('requires a live candidate review before sending one exact confirmation', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const requestPropertyGeocode = vi.fn().mockResolvedValue({
      schemaVersion: 'storyops-property-geocode-candidates-v1',
      operationId,
      companyId,
      propertyId,
      propertyVersion: 3,
      addressHash: 'b'.repeat(64),
      candidates: [
        {
          id: candidateId,
          propertyId,
          propertyVersion: 3,
          provider: 'google_maps',
          mode: 'live',
          formattedAddress: '123 Main Street, Dallas, TX 75201, USA',
          latitude: 32.7767,
          longitude: -96.797,
          precision: 'rooftop',
          confidence: 0.99,
          providerPlaceId: 'place-123',
          observedAt: new Date().toISOString(),
          expiresAt,
          evidenceHash: 'a'.repeat(64),
        },
      ],
      requiresHumanConfirmation: true,
      replayed: false,
      serverTime: new Date().toISOString(),
    });
    const confirmPropertyGeocode = vi.fn().mockResolvedValue({
      schemaVersion: 'storyops-property-geocode-confirmation-v1',
      commandId: '94900000-0000-4000-8000-000000000003',
      companyId,
      propertyId,
      propertyVersion: 4,
      candidateId,
      provider: 'google_maps',
      precision: 'rooftop',
      confidence: 0.99,
      confirmedAt: new Date().toISOString(),
      requestHash: 'c'.repeat(64),
      replayed: false,
    });
    mocked.value = {
      state: liveState(),
      actions: {
        requestPropertyGeocode,
        confirmPropertyGeocode,
      } as unknown as StoryOpsActions,
      can: () => true,
    };
    renderCustomers();

    fireEvent.click(screen.getByRole('button', { name: 'Open Morgan Ellis' }));
    const dialog = screen.getByRole('dialog', { name: 'Morgan Ellis' });
    expect(within(dialog).getByText('Review required')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: /confirm exact address/iu })).toBeNull();

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Request live address candidates' }),
    );
    expect(await within(dialog).findByText('123 Main Street, Dallas, TX 75201, USA')).toBeVisible();
    expect(requestPropertyGeocode).toHaveBeenCalledWith({
      propertyId,
      expectedPropertyVersion: 3,
    });

    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Confirm exact address 123 Main Street, Dallas, TX 75201, USA',
      }),
    );
    await waitFor(() =>
      expect(confirmPropertyGeocode).toHaveBeenCalledWith({
        propertyId,
        expectedPropertyVersion: 3,
        candidateId,
      }),
    );
  });
});
