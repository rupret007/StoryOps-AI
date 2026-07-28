import { NwsWeatherProvider, VroomRoutingProvider } from '@/core/integrations';

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('live public integration adapters', () => {
  it('follows NWS point metadata and preserves missing forecast values', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          properties: {
            forecastHourly: 'https://api.weather.gov/gridpoints/FWD/1,1/forecast/hourly',
            gridId: 'FWD',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          properties: {
            periods: [
              {
                startTime: '2026-07-29T08:00:00-05:00',
                endTime: '2026-07-29T09:00:00-05:00',
                temperature: 82,
                temperatureUnit: 'F',
                probabilityOfPrecipitation: { value: null },
                windSpeed: '5 to 10 mph',
                shortForecast: 'Partly Cloudy',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ features: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new NwsWeatherProvider('StoryOps AI test (ops@example.test)');

    const result = await provider.forecast({
      coordinates: { latitude: 33.0462, longitude: -96.9942 },
      window: {
        start: '2026-07-29T12:00:00.000Z',
        end: '2026-07-29T15:00:00.000Z',
      },
    });

    expect(result.office).toBe('FWD');
    expect(result.periods[0]).toMatchObject({
      temperatureF: 82,
      precipitationProbability: null,
      windMph: 10,
      shortForecast: 'Partly Cloudy',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps string IDs to VROOM integer IDs and back', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        code: 0,
        routes: [
          {
            vehicle: 1,
            duration: 900,
            service: 600,
            distance: 5000,
            steps: [{ type: 'start' }, { type: 'job', id: 1 }, { type: 'end' }],
          },
        ],
        unassigned: [{ id: 2 }],
        summary: { duration: 900, service: 600, distance: 5000 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new VroomRoutingProvider({
      url: 'https://vroom.example.test/',
    });

    const result = await provider.optimize({
      idempotencyKey: 'routing-key-1',
      jobs: [
        {
          id: 'job-a',
          location: { latitude: 33, longitude: -97 },
          serviceSeconds: 600,
          timeWindows: [
            {
              start: '2026-07-29T13:00:00.000Z',
              end: '2026-07-29T17:00:00.000Z',
            },
          ],
        },
        {
          id: 'job-b',
          location: { latitude: 33.1, longitude: -97.1 },
          serviceSeconds: 900,
          timeWindows: [],
        },
      ],
      vehicles: [
        {
          id: 'truck-1',
          start: { latitude: 33, longitude: -97 },
          availability: {
            start: '2026-07-29T12:00:00.000Z',
            end: '2026-07-29T22:00:00.000Z',
          },
        },
      ],
    });

    expect(result.routes[0]).toMatchObject({
      vehicleId: 'truck-1',
      jobIds: ['job-a'],
    });
    expect(result.unassignedJobIds).toEqual(['job-b']);
    const sentBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { jobs: Array<{ location: number[] }> };
    expect(sentBody.jobs[0]?.location).toEqual([-97, 33]);
  });

  it('fails closed when NWS omits the authoritative alerts feature list', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          properties: {
            forecast: 'https://api.weather.gov/gridpoints/FWD/1,1/forecast',
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ properties: { periods: [] } }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NwsWeatherProvider('StoryOps AI test (ops@example.test)');
    await expect(
      provider.forecast({
        coordinates: { latitude: 33.0462, longitude: -96.9942 },
        window: {
          start: '2026-07-29T12:00:00.000Z',
          end: '2026-07-29T15:00:00.000Z',
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects remote plaintext VROOM endpoints', () => {
    expect(
      () =>
        new VroomRoutingProvider({
          url: 'http://routing.example.test',
          authorization: 'Bearer secret',
        }),
    ).toThrow(/HTTPS/u);
  });
});
