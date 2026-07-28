import { Decimal } from 'decimal.js';
import type { DecimalString, DomainId, ISODate, ISODateTime, PostalAddress } from './primitives.ts';

export interface CapacityWindow {
  crewId: DomainId;
  startsAt: ISODateTime;
  endsAt: ISODateTime;
  availableMinutes: number;
  reservedMinutes: number;
  skills: readonly string[];
  equipmentIds: readonly DomainId[];
}

export interface RouteCheck {
  checkedAt: ISODateTime;
  provider: 'vroom' | 'mock';
  routeFeasible: boolean;
  driveMinutes: number;
  addedDistanceMiles: DecimalString;
  violations: readonly string[];
}

export interface WeatherSnapshot {
  provider: 'nws' | 'mock';
  forecastIssuedAt: ISODateTime;
  checkedAt: ISODateTime;
  periodStartsAt: ISODateTime;
  periodEndsAt: ISODateTime;
  temperatureF: DecimalString;
  precipitationProbability: DecimalString;
  windSpeedMph: DecimalString;
  lightningRisk: 'none' | 'low' | 'elevated' | 'severe' | 'unknown';
  conditionCodes: readonly string[];
}

export interface WeatherPolicy {
  minimumTemperatureF: DecimalString;
  maximumTemperatureF: DecimalString;
  maximumWindSpeedMph: DecimalString;
  maximumPrecipitationProbability: DecimalString;
  prohibitedLightningRisks: readonly WeatherSnapshot['lightningRisk'][];
  prohibitedConditionCodes: readonly string[];
  maximumForecastAgeMinutes: number;
}

export interface BookingRequest {
  companyId: DomainId;
  propertyId: DomainId;
  quoteId: DomainId;
  serviceDate: ISODate;
  serviceAddress: PostalAddress;
  requestedStartsAt: ISODateTime;
  requestedEndsAt: ISODateTime;
  requiredMinutes: number;
  requiredSkills: readonly string[];
  requiredEquipmentIds: readonly DomainId[];
}

export interface BookingEvaluation {
  disposition: 'eligible' | 'requires_approval' | 'unavailable';
  reasons: readonly string[];
  crewId?: DomainId;
  evaluatedAt: ISODateTime;
}

const differenceInMinutes = (later: ISODateTime, earlier: ISODateTime): number =>
  Math.floor((Date.parse(later) - Date.parse(earlier)) / 60_000);

export const evaluateBooking = (
  request: BookingRequest,
  capacity: CapacityWindow,
  route: RouteCheck,
  weather: WeatherSnapshot,
  weatherPolicy: WeatherPolicy,
  evaluatedAt: ISODateTime,
): BookingEvaluation => {
  const unavailableReasons: string[] = [];
  const approvalReasons: string[] = [];

  const requestStarts = Date.parse(request.requestedStartsAt);
  const requestEnds = Date.parse(request.requestedEndsAt);
  if (
    requestStarts < Date.parse(capacity.startsAt) ||
    requestEnds > Date.parse(capacity.endsAt) ||
    request.requiredMinutes > capacity.availableMinutes - capacity.reservedMinutes
  ) {
    unavailableReasons.push('Requested work does not fit remaining crew capacity.');
  }

  const missingSkills = request.requiredSkills.filter((skill) => !capacity.skills.includes(skill));
  if (missingSkills.length > 0) {
    unavailableReasons.push(`Crew is missing required skills: ${missingSkills.join(', ')}.`);
  }
  const missingEquipment = request.requiredEquipmentIds.filter(
    (equipmentId) => !capacity.equipmentIds.includes(equipmentId),
  );
  if (missingEquipment.length > 0) {
    unavailableReasons.push('Required equipment is not assigned to the crew.');
  }
  if (!route.routeFeasible || route.violations.length > 0) {
    unavailableReasons.push('Route check is infeasible or has constraint violations.');
  }

  if (
    differenceInMinutes(evaluatedAt, weather.checkedAt) > weatherPolicy.maximumForecastAgeMinutes
  ) {
    approvalReasons.push('Weather check is stale and must be refreshed.');
  }
  if (
    new Decimal(weather.temperatureF).lessThan(weatherPolicy.minimumTemperatureF) ||
    new Decimal(weather.temperatureF).greaterThan(weatherPolicy.maximumTemperatureF)
  ) {
    unavailableReasons.push('Forecast temperature is outside the approved operating range.');
  }
  if (new Decimal(weather.windSpeedMph).greaterThan(weatherPolicy.maximumWindSpeedMph)) {
    unavailableReasons.push('Forecast wind exceeds the approved operating limit.');
  }
  if (
    new Decimal(weather.precipitationProbability).greaterThan(
      weatherPolicy.maximumPrecipitationProbability,
    )
  ) {
    approvalReasons.push('Forecast precipitation probability exceeds the preferred limit.');
  }
  if (weatherPolicy.prohibitedLightningRisks.includes(weather.lightningRisk)) {
    unavailableReasons.push('Forecast lightning risk is prohibited.');
  }
  if (
    weather.conditionCodes.some((condition) =>
      weatherPolicy.prohibitedConditionCodes.includes(condition),
    )
  ) {
    unavailableReasons.push('Forecast includes a prohibited weather condition.');
  }

  if (unavailableReasons.length > 0) {
    return {
      disposition: 'unavailable',
      reasons: [...unavailableReasons, ...approvalReasons],
      evaluatedAt,
    };
  }
  if (approvalReasons.length > 0) {
    return {
      disposition: 'requires_approval',
      reasons: approvalReasons,
      crewId: capacity.crewId,
      evaluatedAt,
    };
  }
  return {
    disposition: 'eligible',
    reasons: [],
    crewId: capacity.crewId,
    evaluatedAt,
  };
};
