import {
  createSandboxIntegrationSuite,
  createSandboxOfficeToolRegistry,
} from '@/core/integrations';
import type { SmsProvider } from '@/core/integrations/contracts';

describe('generic AI SMS release boundary', () => {
  it('rejects a live provider suite before any generic tool can be registered', () => {
    const suite = createSandboxIntegrationSuite();
    const sendSms = vi.fn<SmsProvider['sendSms']>(async () => {
      throw new Error('provider create must not be reached');
    });
    suite.sms = {
      provider: 'twilio',
      capability: 'sms',
      mode: 'live',
      health: async () => ({
        provider: 'twilio',
        capability: 'sms',
        mode: 'live',
        status: 'healthy',
        checkedAt: '2026-07-29T12:00:00.000Z',
        latencyMs: 1,
        message: 'synthetic test provider',
        requiredEnvironment: [],
      }),
      sendSms,
      getSmsDelivery: async () => undefined,
    };
    expect(() => createSandboxOfficeToolRegistry(suite)).toThrow(
      /Generic AI integration tools cannot register live providers/u,
    );
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('retains non-idempotent, approval-only SMS metadata in sandbox', () => {
    const registry = createSandboxOfficeToolRegistry(createSandboxIntegrationSuite());
    expect(registry.metadata('communications.send_sms')).toMatchObject({
      supportsIdempotency: false,
      sideEffect: 'external_write',
      autoExecute: false,
    });
  });
});
