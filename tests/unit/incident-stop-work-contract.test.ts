import { describe, expect, it } from 'vitest';
import { incidentPausePayloadSchema, incidentPauseReceiptSchema } from '@/core/incidents/contracts';

const payload = {
  schemaVersion: 'storyops-incident-pause-v1',
  action: 'incident.report_pause',
  actorUserId: '10000000-0000-4000-8000-000000000103',
  entityId: '95000000-0000-4000-8000-000000000501',
  incidentNumber: 'INC-95000000',
  visitId: '10000000-0000-4000-8000-000000000641',
  jobId: '10000000-0000-4000-8000-000000000631',
  propertyId: '10000000-0000-4000-8000-000000000211',
  severity: 'minor',
  category: 'other',
  occurredAt: '2026-07-30T12:00:00.000Z',
  requestedAt: '2026-07-30T12:00:01.000Z',
  summary: 'A directly observed incident with exact factual detail.',
  immediateActions: 'Stopped work and isolated the affected area.',
  requiresLegalReview: false,
} as const;

describe('atomic incident stop-work contracts', () => {
  it('accepts only the finite exact request vocabulary', () => {
    expect(incidentPausePayloadSchema.parse(payload)).toEqual(payload);
    expect(
      incidentPausePayloadSchema.safeParse({ ...payload, sendCustomerMessage: true }).success,
    ).toBe(false);
    expect(
      incidentPausePayloadSchema.safeParse({
        ...payload,
        actorUserId: '10000000-0000-4000-8000-000000000101',
      }).success,
    ).toBe(true);
    expect(
      incidentPausePayloadSchema.safeParse({ ...payload, immediateActions: 'stop' }).success,
    ).toBe(false);
  });

  it('requires a durable paused-visit receipt with versioned timer stops', () => {
    const receipt = {
      schemaVersion: 'storyops-incident-pause-receipt-v1',
      action: 'incident.report_pause',
      commandId: '95000000-0000-4000-8000-000000000502',
      commandType: 'incident.report_pause',
      status: 'applied',
      companyId: '10000000-0000-4000-8000-000000000001',
      actorUserId: payload.actorUserId,
      requestHash: 'a'.repeat(64),
      replayed: false,
      entityId: payload.entityId,
      version: 1,
      incident: {
        id: payload.entityId,
        incidentNumber: payload.incidentNumber,
        status: 'open',
        version: 1,
      },
      visit: {
        id: payload.visitId,
        jobId: payload.jobId,
        propertyId: payload.propertyId,
        previousStatus: 'on_site',
        currentStatus: 'paused',
        submittedExpectedVersion: 4,
        previousVersion: 6,
        currentVersion: 7,
      },
      stoppedTimeEntries: [
        {
          id: '95000000-0000-4000-8000-000000000503',
          previousVersion: 1,
          currentVersion: 2,
          endedAt: payload.requestedAt,
        },
      ],
      serverTime: payload.requestedAt,
    };
    expect(incidentPauseReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(
      incidentPauseReceiptSchema.safeParse({
        ...receipt,
        visit: { ...receipt.visit, currentStatus: 'on_site' },
      }).success,
    ).toBe(false);
    expect(
      incidentPauseReceiptSchema.safeParse({
        ...receipt,
        visit: { ...receipt.visit, previousVersion: 3 },
      }).success,
    ).toBe(false);
    expect(
      incidentPauseReceiptSchema.safeParse({
        ...receipt,
        visit: { ...receipt.visit, currentVersion: 8 },
      }).success,
    ).toBe(false);
    expect(
      incidentPauseReceiptSchema.safeParse({
        ...receipt,
        visit: {
          ...receipt.visit,
          previousStatus: 'paused',
          currentVersion: receipt.visit.previousVersion,
        },
      }).success,
    ).toBe(true);
  });
});
