import type {
  IntegrationHealth,
  RoutePlan,
  RoutingProvider,
  RoutingRequest,
  WeatherForecast,
  WeatherForecastRequest,
  WeatherProvider,
} from './contracts.ts';
import { IntegrationError } from './contracts.ts';
import { createIntegrationProbeEvidence } from './probeEvidence.ts';

const DEFAULT_PUBLIC_PROVIDER_TIMEOUT_MS = 15_000;

function boundedSignal(signal?: AbortSignal, timeoutMs = DEFAULT_PUBLIC_PROVIDER_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function validatedProviderUrl(value: string, provider: string): string {
  const url = new URL(value);
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(isLoopback && url.protocol === 'http:')) {
    throw new IntegrationError(
      `${provider} endpoints must use HTTPS outside local development.`,
      provider,
      'INSECURE_PROVIDER_ENDPOINT',
      false,
    );
  }
  return url.toString();
}

function requiredNonnegativeNumber(value: unknown, provider: string, field: string): number {
  const parsed = numberOrNull(value);
  if (parsed === null || parsed < 0) {
    throw new IntegrationError(
      `${provider} response omitted or invalidated ${field}.`,
      provider,
      'INVALID_RESPONSE',
      false,
    );
  }
  return parsed;
}

async function fetchJson(
  provider: string,
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_PUBLIC_PROVIDER_TIMEOUT_MS,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: boundedSignal(init.signal ?? undefined, timeoutMs),
    });
  } catch (error) {
    throw new IntegrationError(
      `${provider} network request failed.`,
      provider,
      'NETWORK_ERROR',
      true,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new IntegrationError(
      `${provider} returned HTTP ${response.status}.`,
      provider,
      `HTTP_${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new IntegrationError(
      `${provider} returned invalid JSON.`,
      provider,
      'INVALID_RESPONSE',
      false,
      { cause: error },
    );
  }
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maximumBytes - received;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      received += chunk.byteLength;
      if (value.byteLength > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseWindMph(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const values = [...value.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  return values.length > 0 ? Math.max(...values) : null;
}

function periodsOverlap(
  left: { start: string; end: string },
  right: { start: string; end: string },
): boolean {
  return (
    new Date(left.start).getTime() < new Date(right.end).getTime() &&
    new Date(right.start).getTime() < new Date(left.end).getTime()
  );
}

export class NwsWeatherProvider implements WeatherProvider {
  readonly provider = 'nws';
  readonly capability = 'weather';
  readonly mode = 'live' as const;

  constructor(
    private readonly userAgent: string,
    private readonly baseUrl = 'https://api.weather.gov',
  ) {
    if (!userAgent.includes('@')) {
      throw new Error(
        'NWS_USER_AGENT must identify StoryOps AI and include a monitored contact address.',
      );
    }
    this.baseUrl = validatedProviderUrl(baseUrl, this.provider).replace(/\/$/u, '');
  }

  private headers(): HeadersInit {
    return {
      accept: 'application/geo+json',
      'user-agent': this.userAgent,
    };
  }

  async health(signal?: AbortSignal): Promise<IntegrationHealth> {
    const started = performance.now();
    try {
      const response = await fetchJson(this.provider, `${this.baseUrl}/points/32.7767,-96.797`, {
        headers: this.headers(),
        signal,
      });
      return {
        provider: this.provider,
        capability: this.capability,
        mode: this.mode,
        status: 'healthy',
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        message: 'NWS points API is reachable.',
        requiredEnvironment: ['NWS_USER_AGENT'],
        probeEvidence: await createIntegrationProbeEvidence(
          'external_read',
          'nws.points.retrieve',
          response,
        ),
      };
    } catch (error) {
      return {
        provider: this.provider,
        capability: this.capability,
        mode: this.mode,
        status: 'down',
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        message: error instanceof Error ? error.message : 'NWS health check failed.',
        requiredEnvironment: ['NWS_USER_AGENT'],
      };
    }
  }

  async forecast(request: WeatherForecastRequest, signal?: AbortSignal): Promise<WeatherForecast> {
    const pointResponse = record(
      await fetchJson(
        this.provider,
        `${this.baseUrl}/points/${request.coordinates.latitude.toFixed(4)},${request.coordinates.longitude.toFixed(4)}`,
        { headers: this.headers(), signal },
      ),
    );
    const pointProperties = record(pointResponse?.properties);
    const forecastUrl = stringOrNull(pointProperties?.forecastHourly ?? pointProperties?.forecast);
    if (!forecastUrl || !forecastUrl.startsWith('https://')) {
      throw new IntegrationError(
        'NWS points response did not include a valid forecast URL.',
        this.provider,
        'INVALID_RESPONSE',
        false,
      );
    }

    const [forecastResponse, alertsResponse] = await Promise.all([
      fetchJson(this.provider, forecastUrl, {
        headers: this.headers(),
        signal,
      }),
      fetchJson(
        this.provider,
        `${this.baseUrl}/alerts/active?point=${request.coordinates.latitude.toFixed(4)},${request.coordinates.longitude.toFixed(4)}`,
        { headers: this.headers(), signal },
      ),
    ]);
    const forecastProperties = record(record(forecastResponse)?.properties);
    const issuedAt = stringOrNull(forecastProperties?.updated);
    if (!issuedAt || !Number.isFinite(Date.parse(issuedAt))) {
      throw new IntegrationError(
        'NWS forecast response omitted its authoritative update timestamp.',
        this.provider,
        'INVALID_RESPONSE',
        false,
      );
    }
    const rawPeriods = Array.isArray(forecastProperties?.periods) ? forecastProperties.periods : [];
    const periods = rawPeriods
      .map((rawPeriod) => {
        const period = record(rawPeriod);
        const start = stringOrNull(period?.startTime);
        const end = stringOrNull(period?.endTime);
        if (!start || !end) return undefined;
        const rawTemperature = numberOrNull(period?.temperature);
        const temperatureUnit = stringOrNull(period?.temperatureUnit);
        const temperatureF =
          rawTemperature === null
            ? null
            : temperatureUnit === 'C'
              ? (rawTemperature * 9) / 5 + 32
              : rawTemperature;
        const precipitation = record(period?.probabilityOfPrecipitation);
        return {
          start,
          end,
          temperatureF,
          precipitationProbability: numberOrNull(precipitation?.value),
          windMph: parseWindMph(period?.windSpeed),
          shortForecast: stringOrNull(period?.shortForecast) ?? 'Unknown',
        };
      })
      .filter((period) => period !== undefined)
      .filter((period) => periodsOverlap(period, request.window));

    const rawAlertFeatures = record(alertsResponse)?.features;
    if (!Array.isArray(rawAlertFeatures)) {
      throw new IntegrationError(
        'NWS alerts response omitted its authoritative feature list.',
        this.provider,
        'INVALID_RESPONSE',
        false,
      );
    }
    const alertFeatures: unknown[] = rawAlertFeatures;
    const alerts = alertFeatures
      .map((feature) => record(record(feature)?.properties))
      .filter((properties): properties is Record<string, unknown> => properties !== undefined)
      .map((properties) => ({
        severity: stringOrNull(properties.severity) ?? 'Unknown',
        event: stringOrNull(properties.event) ?? 'Weather alert',
        headline: stringOrNull(properties.headline) ?? 'NWS alert',
      }));

    return {
      provider: this.provider,
      mode: this.mode,
      office: stringOrNull(pointProperties?.gridId),
      periods,
      alerts,
      issuedAt: new Date(issuedAt).toISOString(),
      observedAt: new Date().toISOString(),
      unknowns:
        periods.length === 0
          ? ['NWS returned no forecast periods inside the requested job window.']
          : [],
    };
  }
}

type VroomConfig = {
  url: string;
  healthUrl?: string;
  authorization?: string;
  requestTimeoutMs?: number;
};

export class VroomRoutingProvider implements RoutingProvider {
  readonly provider = 'vroom';
  readonly capability = 'routing';
  readonly mode = 'live' as const;

  constructor(private readonly config: VroomConfig) {
    if (
      config.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(config.requestTimeoutMs) ||
        config.requestTimeoutMs < 250 ||
        config.requestTimeoutMs > 120_000)
    ) {
      throw new IntegrationError(
        'VROOM request timeout must be an integer between 250 and 120000 milliseconds.',
        this.provider,
        'INVALID_TIMEOUT',
        false,
      );
    }
    this.config = {
      ...config,
      url: validatedProviderUrl(config.url, this.provider),
      healthUrl: config.healthUrl
        ? validatedProviderUrl(config.healthUrl, this.provider)
        : undefined,
    };
  }

  private headers(): HeadersInit {
    return {
      'content-type': 'application/json',
      ...(this.config.authorization ? { authorization: this.config.authorization } : {}),
    };
  }

  async health(signal?: AbortSignal): Promise<IntegrationHealth> {
    const started = performance.now();
    const healthUrl = this.config.healthUrl;
    if (!healthUrl) {
      return {
        provider: this.provider,
        capability: this.capability,
        mode: this.mode,
        status: 'degraded',
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
        message: 'VROOM_URL is configured; set VROOM_HEALTH_URL for an active health probe.',
        requiredEnvironment: ['VROOM_URL'],
      };
    }
    try {
      const response = await fetch(healthUrl, {
        method: 'GET',
        headers: this.headers(),
        signal: boundedSignal(signal, this.config.requestTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`VROOM health endpoint returned HTTP ${response.status}.`);
      }
      const responseBody = await readBoundedResponseText(response, 4_096);
      return {
        provider: this.provider,
        capability: this.capability,
        mode: this.mode,
        status: 'healthy',
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        message: 'VROOM health endpoint is reachable.',
        requiredEnvironment: ['VROOM_URL', 'VROOM_HEALTH_URL'],
        probeEvidence: await createIntegrationProbeEvidence(
          'external_read',
          'vroom.health.retrieve',
          { status: response.status, body: responseBody },
        ),
      };
    } catch (error) {
      return {
        provider: this.provider,
        capability: this.capability,
        mode: this.mode,
        status: 'down',
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        message: error instanceof Error ? error.message : 'VROOM health check failed.',
        requiredEnvironment: ['VROOM_URL', 'VROOM_HEALTH_URL'],
      };
    }
  }

  async optimize(request: RoutingRequest, signal?: AbortSignal): Promise<RoutePlan> {
    if (request.jobs.length === 0 || request.vehicles.length === 0) {
      throw new IntegrationError(
        'Routing requires at least one known job and vehicle.',
        this.provider,
        'INVALID_REQUEST',
        false,
      );
    }
    if (new Set(request.jobs.map((job) => job.id)).size !== request.jobs.length) {
      throw new IntegrationError(
        'Routing job IDs must be unique.',
        this.provider,
        'INVALID_REQUEST',
        false,
      );
    }
    if (new Set(request.vehicles.map((vehicle) => vehicle.id)).size !== request.vehicles.length) {
      throw new IntegrationError(
        'Routing vehicle IDs must be unique.',
        this.provider,
        'INVALID_REQUEST',
        false,
      );
    }
    const jobIds = new Map(request.jobs.map((job, index) => [index + 1, job.id]));
    const vehicleIds = new Map(request.vehicles.map((vehicle, index) => [index + 1, vehicle.id]));
    const unix = (value: string) => Math.floor(new Date(value).getTime() / 1_000);
    const payload = {
      jobs: request.jobs.map((job, index) => ({
        id: index + 1,
        location: [job.location.longitude, job.location.latitude],
        service: job.serviceSeconds,
        time_windows: job.timeWindows.map((window) => [unix(window.start), unix(window.end)]),
      })),
      vehicles: request.vehicles.map((vehicle, index) => ({
        id: index + 1,
        profile: 'driving-car',
        start: [vehicle.start.longitude, vehicle.start.latitude],
        ...(vehicle.end ? { end: [vehicle.end.longitude, vehicle.end.latitude] } : {}),
        ...(vehicle.capacity ? { capacity: vehicle.capacity } : {}),
        time_window: [unix(vehicle.availability.start), unix(vehicle.availability.end)],
      })),
    };
    const response = record(
      await fetchJson(
        this.provider,
        this.config.url,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal,
        },
        this.config.requestTimeoutMs,
      ),
    );
    if (response?.code !== 0) {
      throw new IntegrationError(
        `VROOM rejected the optimization request with code ${String(response?.code)}.`,
        this.provider,
        'OPTIMIZATION_REJECTED',
        false,
      );
    }
    const rawRoutes = Array.isArray(response.routes) ? response.routes : [];
    const seenVehicleIds = new Set<string>();
    const seenJobIds = new Set<string>();
    const routes = rawRoutes.map((rawRoute) => {
      const route = record(rawRoute);
      const vehicleId = vehicleIds.get(numberOrNull(route?.vehicle) ?? -1);
      if (!vehicleId || seenVehicleIds.has(vehicleId)) {
        throw new IntegrationError(
          'VROOM returned an unknown or duplicate route vehicle.',
          this.provider,
          'INVALID_RESPONSE',
          false,
        );
      }
      seenVehicleIds.add(vehicleId);
      const steps = Array.isArray(route?.steps) ? route.steps : [];
      const routedJobs = steps
        .map((step) => record(step))
        .filter((step) => step?.type === 'job')
        .map((step) => {
          const jobId = jobIds.get(numberOrNull(step?.id) ?? -1);
          if (!jobId || seenJobIds.has(jobId)) {
            throw new IntegrationError(
              'VROOM returned an unknown or duplicate routed job.',
              this.provider,
              'INVALID_RESPONSE',
              false,
            );
          }
          seenJobIds.add(jobId);
          return jobId;
        });
      return {
        vehicleId,
        jobIds: routedJobs,
        travelSeconds: requiredNonnegativeNumber(route?.duration, this.provider, 'route duration'),
        serviceSeconds: requiredNonnegativeNumber(
          route?.service,
          this.provider,
          'route service time',
        ),
        distanceMeters: requiredNonnegativeNumber(route?.distance, this.provider, 'route distance'),
      };
    });
    const rawUnassigned = Array.isArray(response.unassigned) ? response.unassigned : [];
    const unassignedJobIds = rawUnassigned.map((item) => {
      const jobId = jobIds.get(numberOrNull(record(item)?.id) ?? -1);
      if (!jobId || seenJobIds.has(jobId)) {
        throw new IntegrationError(
          'VROOM returned an unknown or duplicate unassigned job.',
          this.provider,
          'INVALID_RESPONSE',
          false,
        );
      }
      seenJobIds.add(jobId);
      return jobId;
    });
    if (seenJobIds.size !== request.jobs.length) {
      throw new IntegrationError(
        'VROOM response did not account for every submitted job exactly once.',
        this.provider,
        'INCOMPLETE_RESPONSE',
        false,
      );
    }
    const summary = record(response.summary);
    return {
      provider: this.provider,
      mode: this.mode,
      routes,
      unassignedJobIds,
      summary: {
        travelSeconds: requiredNonnegativeNumber(
          summary?.duration,
          this.provider,
          'summary duration',
        ),
        serviceSeconds: requiredNonnegativeNumber(
          summary?.service,
          this.provider,
          'summary service time',
        ),
        distanceMeters: requiredNonnegativeNumber(
          summary?.distance,
          this.provider,
          'summary distance',
        ),
      },
    };
  }
}
