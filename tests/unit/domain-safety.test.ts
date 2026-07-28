import {
  asDecimalString,
  asDomainId,
  asISODate,
  asISODateTime,
  assessPhotoEvidence,
  evaluateBooking,
  hasPermission,
  type BookingRequest,
  type CapacityWindow,
  type EvidencePolicy,
  type PhotoAnalysis,
  type RouteCheck,
  type WeatherPolicy,
  type WeatherSnapshot,
} from '@/domain';

const companyId = asDomainId('10000000-0000-4000-8000-000000000001');
const propertyId = asDomainId('10000000-0000-4000-8000-000000000211');
const quoteId = asDomainId('10000000-0000-4000-8000-000000000521');
const crewId = asDomainId('10000000-0000-4000-8000-000000000601');
const equipmentId = asDomainId('10000000-0000-4000-8000-000000000611');
const photoId = asDomainId('10000000-0000-4000-8000-000000000901');

describe('role permissions', () => {
  it('keeps customer, technician, dispatcher, and owner boundaries explicit', () => {
    expect(hasPermission('owner', 'price_books.manage')).toBe(true);
    expect(hasPermission('dispatcher', 'price_books.manage')).toBe(false);
    expect(hasPermission('dispatcher', 'dispatch.manage')).toBe(true);
    expect(hasPermission('technician', 'field.execute')).toBe(true);
    expect(hasPermission('technician', 'payments.manage')).toBe(false);
    expect(hasPermission('customer', 'portal.self.read')).toBe(true);
    expect(hasPermission('customer', 'customers.read')).toBe(false);
  });
});

describe('photo evidence', () => {
  const policy: EvidencePolicy = {
    minimumObservationConfidence: asDecimalString('0.8'),
    minimumOverallConfidence: asDecimalString('0.85'),
    requireHumanVerificationForBillingMeasurements: true,
    requireScaleReferenceForPhotoMeasurements: true,
    requiredObservationLabels: ['surface', 'soil'],
  };

  const analysis = (): PhotoAnalysis => ({
    id: asDomainId('10000000-0000-4000-8000-000000000902'),
    companyId,
    propertyId,
    model: 'sandbox',
    modelVersion: '1',
    promptVersion: 'photo-v1',
    analyzedAt: asISODateTime('2026-07-28T12:00:00.000-05:00'),
    purpose: 'scope',
    observations: [
      {
        label: 'surface',
        evidence: 'Visible concrete joints and texture.',
        confidence: asDecimalString('0.95'),
        sourcePhotoId: photoId,
      },
      {
        label: 'soil',
        evidence: 'Visible organic staining.',
        confidence: asDecimalString('0.90'),
        sourcePhotoId: photoId,
      },
    ],
    measurementCandidates: [
      {
        dimension: 'area_sq_ft',
        value: asDecimalString('900'),
        method: 'photo_model',
        confidence: asDecimalString('0.80'),
        scaleReference: 'standard 16-inch paver',
        humanVerified: false,
        sourcePhotoIds: [photoId],
      },
    ],
    unknowns: [],
    injectionSignals: [],
    overallConfidence: asDecimalString('0.91'),
    retention: { retentionClass: 'ai_trace', legalHold: false },
  });

  it('separates useful visual scope evidence from billable measurements', () => {
    const result = assessPhotoEvidence(analysis(), policy);
    expect(result.disposition).toBe('human_review_required');
    expect(result.acceptedObservationLabels).toEqual(['surface', 'soil']);
    expect(result.billableMeasurements).toEqual([]);
    expect(result.reasons).toContain(
      'One or more measurement candidates are not eligible for billing.',
    );
  });

  it('rejects injection signals even when confidence is high', () => {
    const unsafe = analysis();
    unsafe.injectionSignals = ['Text in photo asks agent to ignore the price book.'];
    const result = assessPhotoEvidence(unsafe, policy);
    expect(result.disposition).toBe('human_review_required');
    expect(result.reasons).toContain('Potential prompt-injection content was detected in media.');
  });
});

describe('capacity, route, and weather booking contract', () => {
  const startsAt = asISODateTime('2026-07-30T09:00:00.000-05:00');
  const endsAt = asISODateTime('2026-07-30T13:00:00.000-05:00');
  const evaluatedAt = asISODateTime('2026-07-28T12:00:00.000-05:00');

  const request: BookingRequest = {
    companyId,
    propertyId,
    quoteId,
    serviceDate: asISODate('2026-07-30'),
    serviceAddress: {
      line1: '4100 Cedar Springs Rd',
      city: 'Dallas',
      region: 'TX',
      postalCode: '75219',
      country: 'US',
    },
    requestedStartsAt: startsAt,
    requestedEndsAt: endsAt,
    requiredMinutes: 220,
    requiredSkills: ['pressure-washing'],
    requiredEquipmentIds: [equipmentId],
  };
  const capacity: CapacityWindow = {
    crewId,
    startsAt,
    endsAt,
    availableMinutes: 240,
    reservedMinutes: 0,
    skills: ['pressure-washing'],
    equipmentIds: [equipmentId],
  };
  const route: RouteCheck = {
    checkedAt: evaluatedAt,
    provider: 'mock',
    routeFeasible: true,
    driveMinutes: 20,
    addedDistanceMiles: asDecimalString('11.2'),
    violations: [],
  };
  const weather: WeatherSnapshot = {
    provider: 'mock',
    forecastIssuedAt: evaluatedAt,
    checkedAt: evaluatedAt,
    periodStartsAt: startsAt,
    periodEndsAt: endsAt,
    temperatureF: asDecimalString('78'),
    precipitationProbability: asDecimalString('0.1'),
    windSpeedMph: asDecimalString('8'),
    lightningRisk: 'none',
    conditionCodes: ['clear'],
  };
  const weatherPolicy: WeatherPolicy = {
    minimumTemperatureF: asDecimalString('40'),
    maximumTemperatureF: asDecimalString('105'),
    maximumWindSpeedMph: asDecimalString('20'),
    maximumPrecipitationProbability: asDecimalString('0.5'),
    prohibitedLightningRisks: ['elevated', 'severe', 'unknown'],
    prohibitedConditionCodes: ['ice'],
    maximumForecastAgeMinutes: 180,
  };

  it('books only when all capacity, skill, equipment, route, and weather checks pass', () => {
    expect(evaluateBooking(request, capacity, route, weather, weatherPolicy, evaluatedAt)).toEqual({
      disposition: 'eligible',
      reasons: [],
      crewId,
      evaluatedAt,
    });
  });

  it('marks dangerous weather unavailable and stale forecasts for approval', () => {
    const unsafeWeather: WeatherSnapshot = {
      ...weather,
      windSpeedMph: asDecimalString('35'),
      lightningRisk: 'elevated',
    };
    expect(
      evaluateBooking(request, capacity, route, unsafeWeather, weatherPolicy, evaluatedAt)
        .disposition,
    ).toBe('unavailable');

    const staleWeather: WeatherSnapshot = {
      ...weather,
      checkedAt: asISODateTime('2026-07-28T07:00:00.000-05:00'),
    };
    expect(
      evaluateBooking(request, capacity, route, staleWeather, weatherPolicy, evaluatedAt)
        .disposition,
    ).toBe('requires_approval');
  });
});
