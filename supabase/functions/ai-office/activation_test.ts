import {
  isLiveProviderEnabled,
  resolveLiveProviderActivation,
} from '../../../src/core/integrations/configuration.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test('AI Office model activation requires provider mode and structured-AI flag', () => {
  assert(
    !isLiveProviderEnabled(
      { OPENAI_MODE: 'live', OPENAI_LIVE_ENABLED: 'false' },
      'OPENAI_LIVE_ENABLED',
      'OPENAI_MODE',
    ),
    'Mode-only OpenAI configuration must not activate a model call.',
  );
  assert(
    !isLiveProviderEnabled(
      { OPENAI_MODE: 'sandbox', OPENAI_LIVE_ENABLED: 'true' },
      'OPENAI_LIVE_ENABLED',
      'OPENAI_MODE',
    ),
    'Flag-only OpenAI configuration must not activate a model call.',
  );
  assert(
    isLiveProviderEnabled(
      { OPENAI_MODE: 'live', OPENAI_LIVE_ENABLED: 'true' },
      'OPENAI_LIVE_ENABLED',
      'OPENAI_MODE',
    ),
    'Both OpenAI switches must activate the live model boundary.',
  );
});

Deno.test('disabled and partially activated OpenAI vision fail closed', () => {
  for (const environment of [
    { OPENAI_MODE: 'disabled', OPENAI_VISION_LIVE_ENABLED: 'false' },
    { OPENAI_MODE: 'live', OPENAI_VISION_LIVE_ENABLED: 'false' },
    { OPENAI_MODE: 'sandbox', OPENAI_VISION_LIVE_ENABLED: 'true' },
  ]) {
    const activation = resolveLiveProviderActivation(
      environment,
      'OPENAI_VISION_LIVE_ENABLED',
      'OPENAI_MODE',
    );
    assert(
      activation.runtimeMode === 'disabled',
      'Disabled or partial vision activation must fail closed.',
    );
  }
});
