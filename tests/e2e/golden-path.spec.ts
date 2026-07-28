import { expect, test } from '@playwright/test';
import { completeFirstRunSetup } from './helpers';

async function navigateInApp(page: import('@playwright/test').Page, path: string) {
  await page.evaluate((nextPath) => {
    window.history.pushState(null, '', nextPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test('runs the golden path from qualification through recurring maintenance', async ({ page }) => {
  const supabaseStorageRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/storage/v1/')) supabaseStorageRequests.push(request.url());
  });
  await completeFirstRunSetup(page);
  await navigateInApp(page, '/pipeline');
  await expect(
    page.getByRole('heading', { name: 'From first hello to booked work' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Open Morgan Ellis' }).click();
  await page.getByRole('button', { name: 'Qualify with policy' }).click();
  await expect(page.getByText('Lead qualified', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Build estimate' }).click();
  await expect(page.getByRole('heading', { name: 'Build a verified estimate' })).toBeVisible();
  await expect(page.getByText('Decimal arithmetic')).toBeVisible();

  await page.getByRole('button', { name: 'Calculate & check policy' }).click();
  await expect(page.getByText('Estimate is within policy', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send quote & deposit link' }).click();
  await expect(page.getByText('Sandbox quote recorded', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Open customer portal' }).click();
  await expect(page.getByRole('heading', { name: 'Hi, Morgan.' })).toBeVisible();
  await page.getByRole('button', { name: /Accept & record/ }).click();
  await expect(page.getByText('Friday, July 31 · 9:00 AM')).toBeVisible();

  await page.getByRole('button', { name: 'Staff workspace' }).click();
  await navigateInApp(page, '/dispatch');
  await page.getByRole('button', { name: 'Book Fri 9:00 AM' }).click();
  await expect(page.getByText('Sandbox visit recorded', { exact: true })).toBeVisible();

  await navigateInApp(page, '/field');
  await page.getByRole('button', { name: 'Start demo job' }).first().click();
  await expect(page.getByRole('heading', { name: 'Morgan Ellis' })).toBeVisible();
  await expect(page.getByText('On-site timer running')).toBeVisible();

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
  expect(
    supabaseStorageRequests,
    'Sandbox field media must make zero Supabase Storage requests.',
  ).toEqual([]);

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
});
