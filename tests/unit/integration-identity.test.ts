import { assessIntegrationEnvironment } from '@/core/integrations';
import { mapLiveWorkspace } from '@/state/liveWorkspaceMapper';

describe('signed-target provider identity', () => {
  it('maps and probes only the optional signed-target identity', () => {
    const workspace = mapLiveWorkspace({
      schemaVersion: 'storyops-workspace-v1',
      serverTime: '2026-07-28T12:00:00.000Z',
      session: {
        userId: '10000000-0000-4000-8000-000000000101',
        companyId: '10000000-0000-4000-8000-000000000001',
        role: 'owner',
      },
      company: {
        id: '10000000-0000-4000-8000-000000000001',
        name: 'Identity Contract Co',
        timezone: 'America/Chicago',
        currency: 'USD',
        status: 'setup',
        settings: {},
        version: 1,
      },
      integrationHealth: [
        {
          provider: 'signed_storage_targets',
          mode: 'disabled',
          status: 'disabled',
          capabilities: ['server-signed-upload'],
          lastCheckedAt: null,
        },
      ],
    });
    expect(workspace.integrations).toEqual([
      {
        id: 'signed_storage_targets',
        name: 'signed storage targets',
        provider: 'signed_storage_targets',
        mode: 'Disabled',
        status: 'Needs setup',
        capabilities: ['server-signed-upload'],
        lastCheck: 'Not checked',
      },
    ]);

    const health = assessIntegrationEnvironment({});
    expect(health.some((provider) => provider.provider === 'storage')).toBe(false);
    expect(
      health.filter((provider) => provider.provider === 'signed_storage_targets'),
    ).toHaveLength(1);
  });
});
