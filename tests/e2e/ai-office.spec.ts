import { expect, test } from '@playwright/test';
import { completeFirstRunSetup } from './helpers';

async function navigateInApp(page: import('@playwright/test').Page, path: string) {
  await page.evaluate((nextPath) => {
    window.history.pushState(null, '', nextPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test('AI Office sandbox stays explicitly synthetic while exercising the briefing guardrail', async ({
  page,
}) => {
  await completeFirstRunSetup(page);
  await navigateInApp(page, '/office');

  await expect(
    page.getByRole('heading', {
      name: 'Exercise the policy boundary without claiming a live agent ran',
    }),
  ).toBeVisible();
  await expect(page.getByText('Sandbox evidence only', { exact: true })).toBeVisible();
  await expect(page.getByText(/do not prove an OpenAI call/u)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run briefing' })).toBeEnabled();

  await page.getByRole('button', { name: 'Run briefing' }).click();
  await expect(page.getByText('Owner briefing refreshed', { exact: true })).toBeVisible();
  await expect(page.getByText(/Refreshed read-only owner briefing/u)).toBeVisible();
  await expect(page.getByText(/no records changed/u)).toBeVisible();
  await expect(page.locator('#main-content')).not.toContainText('No scheduler configured');
});
