import { expect, test, type Page } from '@playwright/test';
import {
  completeFirstRunSetup,
  publishSandboxCompanyConfiguration,
  setSandboxPreviewRole,
} from './helpers';

async function navigateInApp(page: Page, path: string) {
  await page.evaluate((nextPath) => {
    window.history.pushState(null, '', nextPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test('customer requests stay request-only and sandbox consent makes no provider call', async ({
  page,
}) => {
  const externalMutations: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (
      request.method() !== 'GET' &&
      (/\/functions\/v1\//u.test(url) ||
        /api\.twilio\.com/u.test(url) ||
        /api\.stripe\.com/u.test(url))
    ) {
      externalMutations.push(url);
    }
  });

  await completeFirstRunSetup(page);
  await publishSandboxCompanyConfiguration(page);
  await navigateInApp(page, '/pipeline');
  await page.getByRole('button', { name: 'Open Morgan Ellis' }).click();
  await page.getByRole('button', { name: 'Qualify with policy' }).click();
  await page.getByRole('button', { name: 'Build estimate' }).click();
  await page.getByRole('button', { name: 'Calculate & check policy' }).click();
  await page.getByRole('button', { name: 'Publish quote to portal' }).click();
  await page.getByRole('link', { name: 'Open customer portal' }).click();
  await page.getByLabel('Type the signer’s full name').fill('Morgan Ellis');
  await page.getByLabel(/I reviewed quote/u).check();
  await page.getByRole('button', { name: /Accept & record/u }).click();
  await page.getByRole('button', { name: 'Staff workspace' }).click();
  await navigateInApp(page, '/dispatch');
  await page.getByRole('button', { name: 'Book Fri 9:00 AM' }).click();
  await setSandboxPreviewRole(page, 'customer');

  await expect(page.getByRole('heading', { name: 'Tell the office what you need' })).toBeVisible();
  await expect(page.getByText('Friday, July 31 · 9:00 AM')).toBeVisible();
  await page.getByLabel('Preferred start date').fill('2026-08-03');
  await page.getByLabel('Preferred end date').fill('2026-08-05');
  await page.getByLabel('Scheduling notes').fill('Tuesday or Wednesday morning would work best.');
  await page.getByRole('button', { name: 'Submit reschedule request' }).click();
  await expect(page.getByText('Friday, July 31 · 9:00 AM')).toBeVisible();
  await expect(page.getByText('Reschedule request', { exact: true })).toBeVisible();

  await page.getByLabel('House exterior soft wash').check();
  await page.getByLabel('Scope notes').fill('Please qualify the north and west elevations.');
  await page.getByRole('button', { name: 'Submit additional-service request' }).click();
  await expect(page.getByText('Additional-service request', { exact: true })).toBeVisible();

  await page.getByLabel(/Opt out of all StoryOps SMS and email/u).check();
  await page.getByRole('button', { name: 'Save communication choices' }).click();
  await expect(page.getByText('Contact suppressed', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Stored only on this device; no live suppression or provider state changes/u),
  ).toBeVisible();
  expect(externalMutations).toEqual([]);
});
