import { z } from 'zod';

export const DISPATCH_CURRENT_ORIGIN_SCHEMA_VERSION = 'storyops-dispatch-current-origin-v1';
export const DISPATCH_ORIGIN_CONSENT_VERSION = 'storyops-dispatch-origin-consent-v1';
export const DISPATCH_ORIGIN_MAX_ACCURACY_METERS = 100;
export const DISPATCH_ORIGIN_MAX_AGE_MS = 2 * 60_000;
export const DISPATCH_ORIGIN_MAX_FUTURE_SKEW_MS = 30_000;

const uuidSchema = z.string().uuid();
const dateTimeSchema = z.string().datetime({ offset: true });

export const dispatchOriginCoordinatesSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();

export const dispatchCurrentOriginSchema = z
  .object({
    schemaVersion: z.literal(DISPATCH_CURRENT_ORIGIN_SCHEMA_VERSION),
    readingId: uuidSchema,
    source: z.literal('device_geolocation'),
    coordinates: dispatchOriginCoordinatesSchema,
    observedAt: dateTimeSchema,
    accuracyMeters: z
      .number()
      .finite()
      .nonnegative()
      .max(DISPATCH_ORIGIN_MAX_ACCURACY_METERS, {
        message: `Device location accuracy must be within ${DISPATCH_ORIGIN_MAX_ACCURACY_METERS} meters.`,
      }),
    consent: z
      .object({
        kind: z.literal('explicit_user_action'),
        disclosureVersion: z.literal(DISPATCH_ORIGIN_CONSENT_VERSION),
        capturedAt: dateTimeSchema,
      })
      .strict(),
  })
  .strict();

export type DispatchCurrentOrigin = z.infer<typeof dispatchCurrentOriginSchema>;

export class DispatchOriginUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchOriginUnavailableError';
  }
}

export interface DispatchGeolocationPosition {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
  };
  timestamp: number;
}

export interface DispatchGeolocationError {
  code: number;
  PERMISSION_DENIED: number;
  TIMEOUT: number;
}

export interface DispatchGeolocation {
  getCurrentPosition(
    success: (position: DispatchGeolocationPosition) => void,
    failure: (error: DispatchGeolocationError) => void,
    options: {
      enableHighAccuracy: boolean;
      maximumAge: number;
      timeout: number;
    },
  ): void;
}

export function assertDispatchCurrentOriginFresh(
  value: unknown,
  nowMs = Date.now(),
): DispatchCurrentOrigin {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new DispatchOriginUnavailableError('Departure-origin verification time is invalid.');
  }
  const origin = dispatchCurrentOriginSchema.parse(value);
  const observedAtMs = Date.parse(origin.observedAt);
  const consentCapturedAtMs = Date.parse(origin.consent.capturedAt);
  if (origin.accuracyMeters > DISPATCH_ORIGIN_MAX_ACCURACY_METERS) {
    throw new DispatchOriginUnavailableError(
      `Device location accuracy must be within ${DISPATCH_ORIGIN_MAX_ACCURACY_METERS} meters.`,
    );
  }
  if (
    observedAtMs < nowMs - DISPATCH_ORIGIN_MAX_AGE_MS ||
    observedAtMs > nowMs + DISPATCH_ORIGIN_MAX_FUTURE_SKEW_MS
  ) {
    throw new DispatchOriginUnavailableError(
      'Device location must have been observed within the last two minutes.',
    );
  }
  if (
    consentCapturedAtMs < nowMs - DISPATCH_ORIGIN_MAX_AGE_MS ||
    consentCapturedAtMs > nowMs + DISPATCH_ORIGIN_MAX_FUTURE_SKEW_MS
  ) {
    throw new DispatchOriginUnavailableError(
      'Location consent must be captured by the current departure action.',
    );
  }
  return origin;
}

export function captureConsentedDispatchOrigin(input?: {
  geolocation?: DispatchGeolocation;
  now?: () => number;
  createReadingId?: () => string;
}): Promise<DispatchCurrentOrigin> {
  const geolocation =
    input?.geolocation ??
    (globalThis as { navigator?: { geolocation?: DispatchGeolocation } }).navigator?.geolocation;
  if (!geolocation) {
    return Promise.reject(
      new DispatchOriginUnavailableError(
        'This device cannot provide a departure location. Departure remains blocked.',
      ),
    );
  }
  const now = input?.now ?? Date.now;
  const createReadingId = input?.createReadingId ?? (() => crypto.randomUUID());
  const consentCapturedAt = new Date(now()).toISOString();

  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      (position) => {
        try {
          resolve(
            assertDispatchCurrentOriginFresh(
              {
                schemaVersion: DISPATCH_CURRENT_ORIGIN_SCHEMA_VERSION,
                readingId: createReadingId(),
                source: 'device_geolocation',
                coordinates: {
                  latitude: position.coords.latitude,
                  longitude: position.coords.longitude,
                },
                observedAt: new Date(position.timestamp).toISOString(),
                accuracyMeters: position.coords.accuracy,
                consent: {
                  kind: 'explicit_user_action',
                  disclosureVersion: DISPATCH_ORIGIN_CONSENT_VERSION,
                  capturedAt: consentCapturedAt,
                },
              },
              now(),
            ),
          );
        } catch (error) {
          reject(error);
        }
      },
      (error) => {
        const detail =
          error.code === error.PERMISSION_DENIED
            ? 'Location permission was denied.'
            : error.code === error.TIMEOUT
              ? 'The device did not return a location in time.'
              : 'The device could not determine a current location.';
        reject(
          new DispatchOriginUnavailableError(
            `${detail} Departure remains blocked until a current accurate reading is shared.`,
          ),
        );
      },
      {
        enableHighAccuracy: true,
        maximumAge: 30_000,
        timeout: 12_000,
      },
    );
  });
}
