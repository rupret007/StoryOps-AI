import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@/core/ai/approval';
import {
  buildCustomerPropertyCreateRequest,
  candidateIsConfirmable,
  lookupHashPayload,
  propertyGeocodeConfirmationHashPayload,
  propertyGeocodeLookupRequestSchema,
} from '@/core/properties/contracts';

const ids = {
  operationId: '94800000-0000-4000-8000-000000000001',
  customerId: '94800000-0000-4000-8000-000000000002',
  propertyId: '94800000-0000-4000-8000-000000000003',
};

describe('atomic customer/property intake', () => {
  it('normalizes one exact request and keeps stable identities/hash on retry', async () => {
    const first = await buildCustomerPropertyCreateRequest(
      {
        displayName: '  Morgan Ellis ',
        email: 'morgan@example.com',
        phone: ' 214-555-0100 ',
        acquisitionSource: ' manual ',
        propertyName: ' Primary property ',
        serviceAddress: {
          line1: ' 123 Main Street ',
          city: ' Dallas ',
          region: ' TX ',
          postalCode: ' 75201 ',
          country: 'us',
        },
        knownHazards: ['steep grade', 'steep grade'],
      },
      ids,
    );
    const replay = await buildCustomerPropertyCreateRequest(
      {
        displayName: 'Morgan Ellis',
        email: 'morgan@example.com',
        phone: '214-555-0100',
        acquisitionSource: 'manual',
        propertyName: 'Primary property',
        serviceAddress: {
          line1: '123 Main Street',
          city: 'Dallas',
          region: 'TX',
          postalCode: '75201',
          country: 'US',
        },
        knownHazards: ['steep grade'],
      },
      ids,
    );
    expect(first).toEqual(replay);
    expect(first.payload.property.serviceAddress.country).toBe('US');
    expect(first.payload.property.knownHazards).toEqual(['steep grade']);
    expect(first.requestHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects invented coordinates and incomplete address facts', async () => {
    await expect(
      buildCustomerPropertyCreateRequest(
        {
          displayName: 'Morgan Ellis',
          serviceAddress: {
            line1: '123',
            city: 'D',
            region: 'TX',
            postalCode: '1',
            country: 'US',
          },
          latitude: 32.7,
        } as never,
        ids,
      ),
    ).rejects.toThrow();
  });
});

describe('property geocode review', () => {
  it('hashes only exact lookup facts and exact confirmation facts', async () => {
    const lookup = propertyGeocodeLookupRequestSchema.parse({
      schemaVersion: 'storyops-property-geocode-lookup-v1',
      companyId: '10000000-0000-4000-8000-000000000001',
      propertyId: ids.propertyId,
      expectedPropertyVersion: 1,
      operationId: ids.operationId,
    });
    expect(await sha256Hex(lookupHashPayload(lookup))).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      propertyGeocodeConfirmationHashPayload({
        propertyId: ids.propertyId,
        propertyVersion: 1,
        candidateId: '94900000-0000-4000-8000-000000000002',
      }),
    ).toEqual({
      action: 'property.geocode.confirm',
      propertyId: ids.propertyId,
      propertyVersion: 1,
      candidateId: '94900000-0000-4000-8000-000000000002',
    });
  });

  it('never treats low-confidence, city-level, stale, or sandbox evidence as confirmable', () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    const candidate = {
      provider: 'google_maps' as const,
      mode: 'live' as const,
      precision: 'rooftop' as const,
      confidence: 0.99,
      expiresAt: '2026-07-31T12:00:00.000Z',
    };
    expect(candidateIsConfirmable(candidate, now)).toBe(true);
    expect(candidateIsConfirmable({ ...candidate, confidence: 0.79 }, now)).toBe(false);
    expect(candidateIsConfirmable({ ...candidate, precision: 'city' }, now)).toBe(false);
    expect(
      candidateIsConfirmable({ ...candidate, expiresAt: '2026-07-30T11:59:59.000Z' }, now),
    ).toBe(false);
  });
});
