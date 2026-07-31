import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(
  new URL('../tests/fixtures/ai-evals/adversarial-v1.json', import.meta.url),
);
const rawFixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const { aiEvalFixtureSetSchema, runAiSafetyEvaluations } =
  await import('../src/core/ai/evals/index.ts');
const fixtureSet = aiEvalFixtureSetSchema.parse(rawFixture);
const report = await runAiSafetyEvaluations(fixtureSet.fixtures);

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.failed === 0 ? 0 : 1;
