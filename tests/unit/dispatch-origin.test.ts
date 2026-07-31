import { describe, expect, it, vi } from 'vitest';
import {
  DISPATCH_ORIGIN_CONSENT_VERSION,
  DispatchOriginUnavailableError,
  assertDispatchCurrentOriginFresh,
  captureConsentedDispatchOrigin,
  type DispatchGeolocation,
  type DispatchGeolocationPosition,
} from '@/core/scheduling/dispatchOrigin';

const readingId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const nowMs = Date.parse('2026-07-30T15:00:00.000Z');

function geolocationPosition(input?: {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  timestamp?: number;
}): DispatchGeolocationPosition {
  return {
    coords: {
      latitude: input?.latitude ?? 32.781,
      longitude: input?.longitude ?? -96.81,
      accuracy: input?.accuracy ?? 18,
    },
    timestamp: input?.timestamp ?? nowMs - 5_000,
  };
}

describe('current dispatch origin', () => {
  it('captures one explicit, accurate, non-base device reading', async () => {
    const getCurrentPosition: DispatchGeolocation['getCurrentPosition'] = vi.fn(
      (success, _failure, options) => {
        success(
          geolocationPosition({
            latitude: 32.781,
            longitude: -96.81,
          }),
        );
        expect(options).toEqual({
          enableHighAccuracy: true,
          maximumAge: 30_000,
          timeout: 12_000,
        });
      },
    );

    await expect(
      captureConsentedDispatchOrigin({
        geolocation: { getCurrentPosition },
        now: () => nowMs,
        createReadingId: () => readingId,
      }),
    ).resolves.toEqual({
      schemaVersion: 'storyops-dispatch-current-origin-v1',
      readingId,
      source: 'device_geolocation',
      coordinates: {
        latitude: 32.781,
        longitude: -96.81,
      },
      observedAt: '2026-07-30T14:59:55.000Z',
      accuracyMeters: 18,
      consent: {
        kind: 'explicit_user_action',
        disclosureVersion: DISPATCH_ORIGIN_CONSENT_VERSION,
        capturedAt: '2026-07-30T15:00:00.000Z',
      },
    });
  });

  it.each([
    {
      label: 'stale',
      observedAt: '2026-07-30T14:57:59.999Z',
      accuracyMeters: 20,
      expected: /last two minutes/u,
    },
    {
      label: 'inaccurate',
      observedAt: '2026-07-30T14:59:50.000Z',
      accuracyMeters: 100.01,
      expected: /within 100 meters/u,
    },
  ])('rejects a $label reading', ({ observedAt, accuracyMeters, expected }) => {
    expect(() =>
      assertDispatchCurrentOriginFresh(
        {
          schemaVersion: 'storyops-dispatch-current-origin-v1',
          readingId,
          source: 'device_geolocation',
          coordinates: { latitude: 32.781, longitude: -96.81 },
          observedAt,
          accuracyMeters,
          consent: {
            kind: 'explicit_user_action',
            disclosureVersion: DISPATCH_ORIGIN_CONSENT_VERSION,
            capturedAt: '2026-07-30T15:00:00.000Z',
          },
        },
        nowMs,
      ),
    ).toThrow(expected);
  });

  it('fails closed when the device has no geolocation capability', async () => {
    await expect(
      captureConsentedDispatchOrigin({
        geolocation: undefined,
        now: () => nowMs,
        createReadingId: () => readingId,
      }),
    ).rejects.toBeInstanceOf(DispatchOriginUnavailableError);
  });
});
