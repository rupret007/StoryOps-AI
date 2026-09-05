import { expect, test } from '@playwright/test';
import { completeFirstRunSetup, publishSandboxCompanyConfiguration } from './helpers';

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
}

function screenshotDirForProject(projectName: string): string {
  return projectName === 'mobile'
    ? 'artifacts/showcase/v1.2/mobile'
    : 'artifacts/showcase/v1.2/desktop';
}

async function capture(page: import('@playwright/test').Page, step: string, projectName: string) {
  await page.screenshot({
    path: `${screenshotDirForProject(projectName)}/${normalizeName(step)}.png`,
    fullPage: true,
  });
}

async function assertShowcaseStep(
  page: import('@playwright/test').Page,
  checkpointTitle: string,
  stepName: string,
  projectName: string,
  returnTo: string,
) {
  await navigateInApp(page, '/showcase');
  await expect(page.getByRole('heading', { name: '8-0-1 Guided demo run' })).toBeVisible();
  const checkpointInList = page.locator('.briefing-item__title', { hasText: checkpointTitle });
  if ((await checkpointInList.count()) > 0) {
    await expect(checkpointInList.first()).toBeVisible();
  } else {
    await expect(page.getByText(checkpointTitle)).toBeVisible();
  }
  await capture(page, stepName, projectName);
  await navigateInApp(page, returnTo);
}

async function navigateInApp(page: import('@playwright/test').Page, path: string) {
  await page.evaluate((nextPath) => {
    window.history.pushState(null, '', nextPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function proceedToEstimateAction(page: import('@playwright/test').Page) {
  await page.goto('/pipeline?lead=lead-morgan');
  const drawer = page.locator('aside.lead-detail-drawer[aria-label="Morgan Ellis lead details"]');
  const estimateAction = drawer.getByRole('button', {
    name: /Build estimate|Open estimate|Link property before estimate/u,
  });
  if (await estimateAction.isVisible()) {
    await estimateAction.click();
    return;
  }

  const qualifyAction = page.getByRole('button', { name: 'Qualify with policy' });
  if (await qualifyAction.isVisible()) {
    await qualifyAction.click();
    await expect(estimateAction).toBeVisible({ timeout: 5000 });
    if (await estimateAction.isVisible()) {
      await estimateAction.click();
      return;
    }
  }

  if (await page.getByRole('button', { name: 'Open estimate' }).isVisible()) {
    await page.getByRole('button', { name: 'Open estimate' }).click();
    return;
  }

  await page.goto(`/estimates/estimate-1048?lead=${encodeURIComponent('lead-morgan')}`);
}

async function runDeterministicEstimatePolicyCheck(page: import('@playwright/test').Page) {
  const estimateIsWithinPolicy = page.getByText('Estimate is within policy', { exact: true });
  const companyConfigRequired = page.getByText('Company configuration required', { exact: true });

  await page.getByRole('button', { name: 'Calculate & check policy' }).click();
  if (await estimateIsWithinPolicy.isVisible()) {
    return;
  }

  await expect(companyConfigRequired.or(estimateIsWithinPolicy)).toBeVisible({ timeout: 5000 });
  await expect(companyConfigRequired).toBeVisible();
  await publishSandboxCompanyConfiguration(page);
  await navigateInApp(page, '/estimates/estimate-1048?lead=lead-morgan');
  await page.getByRole('button', { name: 'Calculate & check policy' }).click();
  await expect(estimateIsWithinPolicy).toBeVisible();
}

async function clickNextShowcaseStep(page: import('@playwright/test').Page) {
  await page
    .getByRole('link', { name: /^Go to /u })
    .first()
    .click();
}

test('showcase guided pilot can complete the six-stage local demo flow', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await completeFirstRunSetup(page);
  await publishSandboxCompanyConfiguration(page);

  await assertShowcaseStep(
    page,
    'Owner dashboard review',
    '01-owner-dashboard',
    testInfo.project.name,
    '/showcase',
  );
  await clickNextShowcaseStep(page);

  await navigateInApp(page, '/pipeline');
  await expect(
    page.getByRole('heading', { name: 'From first hello to booked work' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Morgan Ellis' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Morgan Ellis' }).click();
  await page.getByRole('button', { name: 'Qualify with policy' }).click();
  await proceedToEstimateAction(page);

  await assertShowcaseStep(
    page,
    'Lead qualification',
    '02-lead-qualification-complete',
    testInfo.project.name,
    '/pipeline',
  );
  await proceedToEstimateAction(page);
  await expect(page.getByRole('heading', { name: 'Build a verified estimate' })).toBeVisible();
  await runDeterministicEstimatePolicyCheck(page);
  await page.getByRole('button', { name: 'Publish quote to portal' }).click();
  await expect(
    page.getByText('Sandbox portal publication recorded', { exact: true }),
  ).toBeVisible();

  await assertShowcaseStep(
    page,
    'Photo-assisted scope to deterministic estimate',
    '03-photo-assisted-scope',
    testInfo.project.name,
    '/estimates/estimate-1048',
  );
  await page.getByRole('link', { name: 'Open customer portal' }).click();
  await expect(page.getByRole('heading', { name: 'Hi, Morgan.' })).toBeVisible();
  const signerInput = page.locator('#sandbox-quote-signer');
  await signerInput.waitFor({ state: 'visible', timeout: 10000 });
  await signerInput.fill('Morgan Ellis');
  await page.getByLabel(/I reviewed quote/u).check();
  await page.getByRole('button', { name: /Accept & record/u }).click();
  await expect(page.getByText('Sandbox booking fixture pending', { exact: true })).toBeVisible();

  await assertShowcaseStep(
    page,
    'Dispatch and capacity-aware booking',
    '04-quote-and-terms-complete',
    testInfo.project.name,
    '/dispatch',
  );
  await navigateInApp(page, '/dispatch');
  await page.getByRole('button', { name: 'Book Fri 9:00 AM' }).click();
  await expect(page.getByText('Sandbox visit recorded', { exact: true })).toBeVisible();

  await assertShowcaseStep(
    page,
    'Field closeout + recurring follow-up',
    '05-dispatch-and-route-complete',
    testInfo.project.name,
    '/field',
  );
  await navigateInApp(page, '/field');
  await page.getByRole('button', { name: 'Start demo job' }).first().click();
  await page.getByRole('button', { name: 'Arrived' }).click();
  await expect(page.getByRole('heading', { name: 'Morgan Ellis' })).toBeVisible();
  await expect(page.getByText('On-site timer running', { exact: true })).toBeVisible();

  for (const label of [
    'Arrival walkaround',
    'Before photos',
    'Protect property',
    'Complete approved service',
    'Final rinse and inspection',
    'After photos',
  ]) {
    await page.getByRole('button', { name: `Complete ${label}` }).click();
  }
  await page.getByRole('button', { name: 'Add before' }).click();
  await page.getByRole('button', { name: 'Add after' }).click();
  await page.getByRole('button', { name: 'Record 1 bag' }).click();
  await page.getByLabel('Job notes').fill('Scope completed with no property exceptions.');
  await page.getByLabel('Job notes').blur();
  await page.getByRole('button', { name: 'Signature' }).click();
  await page.getByRole('button', { name: 'Complete job' }).click();
  await expect(page.getByText('Job completed', { exact: true })).toBeVisible();

  await navigateInApp(page, '/finance');
  await page.getByRole('button', { name: 'Issue completed job' }).click();
  await expect(page.getByText('Sandbox invoice recorded', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pay sandbox' }).click();
  await expect(page.getByText('Sandbox payment fixture recorded', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Queue review fixture' }).click();
  await page.getByRole('button', { name: 'Queue referral fixture' }).click();
  await page.getByRole('button', { name: 'Activate plan fixture' }).click();
  await expect(
    page.getByRole('button', { name: 'Review fixture queued', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Referral fixture queued', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Plan fixture active', exact: true }),
  ).toBeVisible();

  await assertShowcaseStep(
    page,
    'The six-stage showcase route is complete',
    '06-complete-tour',
    testInfo.project.name,
    '/finance',
  );
  await capture(page, '07-showcase-final-state', testInfo.project.name);
});
