import { describe, expect, it } from 'vitest';
import {
  confirmedLiveEstimateMatchesDraft,
  reserveLiveEstimateIdempotencyKey,
  type LiveEstimateIntent,
} from '@/state/liveEstimating';

const baseIntent: LiveEstimateIntent = {
  customerId: '10000000-0000-4000-8000-000000000201',
  propertyId: '10000000-0000-4000-8000-000000000211',
  services: [
    {
      serviceCode: 'pressure-wash-flatwork',
      measurementId: '10000000-0000-4000-8000-000000000441',
      attributes: {
        surface: 'concrete',
        soil: 'medium',
        access: 'standard',
        risk: 'standard',
      },
    },
  ],
  travelZoneCode: 'DFW-CORE',
  discount: { kind: 'none' },
};

describe('live estimate idempotency reservation', () => {
  it('reuses the exact key after an ambiguous transport failure', () => {
    let sequence = 0;
    const keyFactory = () => `estimate:key-${++sequence}`;
    const first = reserveLiveEstimateIdempotencyKey(undefined, baseIntent, keyFactory);

    // A committed server response may be lost in transit. Retrying the same
    // canonical intent must replay that receipt instead of creating a quote.
    const retry = reserveLiveEstimateIdempotencyKey(first, structuredClone(baseIntent), keyFactory);

    expect(retry).toEqual(first);
    expect(sequence).toBe(1);
  });

  it('rotates only after confirmed completion or a material input change', () => {
    let sequence = 0;
    const keyFactory = () => `estimate:key-${++sequence}`;
    const first = reserveLiveEstimateIdempotencyKey(undefined, baseIntent, keyFactory);
    const changed = reserveLiveEstimateIdempotencyKey(
      first,
      { ...baseIntent, discount: { kind: 'percent', value: '5', reason: 'Recorded offer' } },
      keyFactory,
    );
    const afterConfirmedReceipt = reserveLiveEstimateIdempotencyKey(
      undefined,
      baseIntent,
      keyFactory,
    );

    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(afterConfirmedReceipt.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(sequence).toBe(3);
  });

  it('treats the published package identity as a material pricing input', () => {
    let sequence = 0;
    const keyFactory = () => `estimate:key-${++sequence}`;
    const custom = reserveLiveEstimateIdempotencyKey(undefined, baseIntent, keyFactory);
    const packaged = reserveLiveEstimateIdempotencyKey(
      custom,
      { ...baseIntent, packageCode: 'ESSENTIAL_CARE' },
      keyFactory,
    );

    expect(packaged.intentFingerprint).not.toBe(custom.intentFingerprint);
    expect(packaged.idempotencyKey).not.toBe(custom.idempotencyKey);
  });

  it('invalidates a confirmed quote when intent or selected lead context changes', () => {
    const confirmed = reserveLiveEstimateIdempotencyKey(undefined, baseIntent, () => 'estimate:a');
    const changed = reserveLiveEstimateIdempotencyKey(
      undefined,
      { ...baseIntent, discount: { kind: 'percent', value: '5', reason: 'Recorded offer' } },
      () => 'estimate:b',
    );

    expect(
      confirmedLiveEstimateMatchesDraft({
        confirmedContextKey: `lead-a:${baseIntent.propertyId}`,
        confirmedIntentFingerprint: confirmed.intentFingerprint,
        currentContextKey: `lead-a:${baseIntent.propertyId}`,
        currentIntentFingerprint: changed.intentFingerprint,
      }),
    ).toBe(false);
    expect(
      confirmedLiveEstimateMatchesDraft({
        confirmedContextKey: `lead-a:${baseIntent.propertyId}`,
        confirmedIntentFingerprint: confirmed.intentFingerprint,
        currentContextKey: `lead-b:${baseIntent.propertyId}`,
        currentIntentFingerprint: confirmed.intentFingerprint,
      }),
    ).toBe(false);
  });
});
