import { describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../../src/core/integrations/liveServer.ts';
import { sha256TextHex } from '../../src/core/integrations/webhooks.ts';

describe('Google Calendar cancellation reconciliation', () => {
  it('surfaces an accepted-or-not booking when POST succeeds but exact read-back fails', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'accepted-by-provider' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockRejectedValueOnce(new TypeError('Connection closed before exact event read-back.'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GoogleCalendarProvider({
      accessToken: 'google-token-redacted',
      calendarId: 'operations@example.test',
    });

    await expect(
      provider.createBooking({
        calendarId: 'operations@example.test',
        title: 'WashOps job',
        window: {
          start: '2026-07-30T14:00:00.000Z',
          end: '2026-07-30T16:00:00.000Z',
        },
        timeZone: 'America/Chicago',
        jobId: '10000000-0000-4000-8000-000000000501',
        idempotencyKey: 'schedule:job-501:accepted-or-not',
      }),
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['POST', 'GET']);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/events/storyops');
  });

  it('reads exact state before delete and confirms absence after an unknown delete response', async () => {
    const idempotencyKey = 'scheduling-reconciliation:unknown-delete:calendar';
    const providerId = `storyops${(await sha256TextHex(idempotencyKey)).slice(0, 40)}`;
    const etag = '"calendar-etag-unknown-delete"';
    const calls: Array<{ url: string; method: string }> = [];
    let phase: 'first-read' | 'unknown-delete' | 'absence-read' = 'first-read';
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (phase === 'first-read') {
        phase = 'unknown-delete';
        return new Response(
          JSON.stringify({
            id: providerId,
            etag,
            status: 'confirmed',
            extendedProperties: {
              private: {
                storyops_idempotency_key: idempotencyKey,
              },
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (phase === 'unknown-delete') {
        phase = 'absence-read';
        throw new TypeError('Connection closed after provider accepted DELETE.');
      }
      return new Response(JSON.stringify({ error: { message: 'Event is gone.' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GoogleCalendarProvider({
      accessToken: 'google-token-redacted',
      calendarId: 'operations@example.test',
    });
    const request = {
      calendarId: 'operations@example.test',
      providerId,
      etag,
      idempotencyKey,
    };

    await expect(provider.cancelBooking(request)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
    });
    await expect(provider.cancelBooking(request)).resolves.toBeUndefined();

    expect(calls.map((call) => call.method)).toEqual(['GET', 'DELETE', 'GET']);
    expect(calls[0]?.url).toContain(`/events/${providerId}`);
    expect(calls[2]?.url).toContain(`/events/${providerId}`);
  });
});
