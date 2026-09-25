import { expect, test } from '@playwright/test';
import {
  completeFirstRunSetup,
  publishSandboxCompanyConfiguration,
  restartSandboxRehearsal,
  setSandboxPreviewRole,
} from './helpers';

async function navigateInApp(page: import('@playwright/test').Page, path: string) {
  await page.evaluate((nextPath) => {
    window.history.pushState(null, '', nextPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test('large discounts require one exact-payload owner approval', async ({ page }) => {
  await completeFirstRunSetup(page);
  await publishSandboxCompanyConfiguration(page);
  await navigateInApp(page, '/estimates/estimate-1048');
  await page.getByLabel('Discount').fill('15');
  await page.getByRole('button', { name: 'Calculate & check policy' }).click();
  await expect(page.getByText('Owner approval required', { exact: true })).toBeVisible();

  await navigateInApp(page, '/portal');
  await expect(page.getByRole('heading', { name: 'No approved quote is available' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Accept & record/u })).toHaveCount(0);

  await navigateInApp(page, '/estimates/estimate-1048');
  await page.getByRole('button', { name: 'Re-run policy check' }).click();
  await navigateInApp(page, '/approvals');
  await expect(page.getByRole('heading', { name: '15% estimate discount' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Approve exact payload' }).first().click();
  await expect(page.getByText('Approval granted', { exact: true })).toBeVisible();

  await navigateInApp(page, '/estimates/estimate-1048');
  await page.getByRole('button', { name: 'Publish quote to portal' }).click();
  await expect(
    page.getByText('Sandbox portal publication recorded', { exact: true }),
  ).toBeVisible();
});

test('role permissions block technician access to approvals and invoice writes', async ({
  page,
}) => {
  await completeFirstRunSetup(page);
  await setSandboxPreviewRole(page, 'technician');
  await navigateInApp(page, '/approvals');
  await expect(
    page.getByRole('heading', { name: 'This role has read-only or no access' }),
  ).toBeVisible();
  await expect(page.getByText(/approvals\.read/)).toBeVisible();

  await navigateInApp(page, '/finance');
  await expect(
    page.getByRole('heading', { name: 'This role has read-only or no access' }),
  ).toBeVisible();
  await expect(page.getByText(/invoices\.read/)).toBeVisible();
});

test('booking cannot bypass quote acceptance and deposit truth', async ({ page }) => {
  await completeFirstRunSetup(page);
  await publishSandboxCompanyConfiguration(page);
  await navigateInApp(page, '/dispatch');
  await page.getByRole('button', { name: 'Book Fri 9:00 AM' }).click();
  await expect(page.getByText('Booking blocked', { exact: true })).toBeVisible();
  await expect(page.getByText(/acceptance and deposit state/)).toBeVisible();
});

test('sandbox operational state is labeled synthetic and never presented as provider truth', async ({
  page,
}) => {
  await completeFirstRunSetup(page);
  await expect(page.getByText(/Sandbox records only/)).toBeVisible();
  await expect(
    page.getByText(/Nothing here is live payment, route, weather, or dispatch evidence/),
  ).toBeVisible();
  await expect(page.getByText('Not dispatch evidence', { exact: true })).toBeVisible();
  await expect(page.locator('#main-content')).not.toContainText('NWS sandbox checked');
  await expect(page.locator('#main-content')).not.toContainText('In policy');

  await navigateInApp(page, '/dispatch');
  await expect(page.getByText(/Synthetic sandbox schedule/)).toBeVisible();
  await expect(page.getByText('Scenario', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.getByText(/no coordinate or provider route evidence/)).toBeVisible();
  await expect(page.locator('#main-content')).not.toContainText('Deposit paid');

  await navigateInApp(page, '/field');
  await expect(page.getByText(/not NWS or provider evidence/)).toBeVisible();
  await expect(page.getByText(/not operational clearance/)).toBeVisible();
  await expect(page.getByText(/Not provider-confirmed/)).toBeVisible();
  await page.getByRole('button', { name: 'Start demo route', exact: true }).click();
  await expect(page.getByText(/no customer was contacted/)).toBeVisible();
  await expect(page.locator('#main-content')).not.toContainText('Customer received');

  await navigateInApp(page, '/finance');
  await expect(page.getByText(/Synthetic sandbox finance scenario/)).toBeVisible();
  await expect(page.getByText(/no Stripe event or customer delivery/)).toBeVisible();

  await navigateInApp(page, '/portal');
  await expect(page.getByText('Sandbox portal preview', { exact: true })).toBeVisible();
  await expect(page.getByText(/No approved quote is available/)).toBeVisible();
});

test('pilot rehearsal shows the next local checkpoint and restart requires confirmation', async ({
  page,
}) => {
  await completeFirstRunSetup(page);
  await expect(page.getByRole('heading', { name: 'Pilot rehearsal' })).toBeVisible();
  await expect(page.getByText('Local-only golden-path checkpoints.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open company setup' })).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await restartSandboxRehearsal(page);
  await expect(
    page.getByRole('heading', { name: 'Tell StoryOps who it works for.' }),
  ).toBeVisible();
});

test('offline field changes recover through an idempotent outbox', async ({
  page,
  context,
  browserName,
}) => {
  await completeFirstRunSetup(page);
  await navigateInApp(page, '/field');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.getByRole('button', { name: 'Start demo job' }).first().click();
  await page.getByRole('button', { name: 'Arrived' }).click();

  await context.setOffline(true);
  await expect(
    page.locator('#main-content').getByText('Browser offline · 0 queued', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Complete Arrival walkaround' }).click();
  await expect(page.getByText(/1 changes queued on this device/)).toBeVisible();
  if (browserName !== 'webkit') {
    await page.waitForTimeout(150);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Selected field visit' })).toBeVisible();
    await expect(page.getByText(/1 changes queued on this device/)).toBeVisible();
  }

  await context.setOffline(false);
  const reconnect = page.getByRole('button', { name: 'Simulate reconnect' });
  if (await reconnect.isVisible()) {
    await reconnect.click();
  }
  await page.getByRole('button', { name: /Sync 1 offline changes/ }).click();
  await expect(page.getByText('Offline changes synced', { exact: true })).toBeVisible();
  await expect(page.getByText(/1 idempotent mutation confirmed/)).toBeVisible();
});

test('incident reports preserve facts and pause affected work', async ({ page }) => {
  await completeFirstRunSetup(page);
  await navigateInApp(page, '/field');
  await page.getByRole('button', { name: 'Start demo job' }).first().click();
  await page.getByRole('button', { name: 'Report incident or damage' }).click();
  await page.getByLabel('Incident type').selectOption('property_damage');
  await page
    .getByLabel('What did you directly observe?')
    .fill('A loose fence board was observed before service began.');
  await page.getByRole('button', { name: 'Open incident & pause' }).click();
  await expect(page.getByText('Incident record opened', { exact: true })).toBeVisible();
  await expect(page.getByText('Timer paused', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'Affected automation is paused. The owner must review evidence and close the incident.',
      { exact: true },
    ),
  ).toBeVisible();
});

test('setup persists the exact local profile across reload', async ({ page }) => {
  await completeFirstRunSetup(page, {
    businessName: 'North Star Exterior',
    ownerName: 'Alex Rivera',
    postalCode: '76102',
    services: ['pressure-wash-flatwork', 'soft-wash-house', 'gutter-cleaning'],
  });

  await expect(page.getByRole('heading', { name: 'Good morning, Alex.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Good morning, Alex.' })).toBeVisible();
  await navigateInApp(page, '/portal');
  await expect(page.getByText('North Star Exterior', { exact: true })).toBeVisible();
});

test('setup service exclusions fail closed at deterministic pricing', async ({ page }) => {
  await completeFirstRunSetup(page, {
    services: ['soft-wash-house', 'gutter-cleaning', 'window-cleaning'],
  });
  await navigateInApp(page, '/estimates/estimate-1048');
  await page.getByRole('button', { name: 'Calculate & check policy' }).click();
  await expect(page.getByText('Company configuration required', { exact: true })).toBeVisible();
  await expect(page.getByText(/Publish the exact sandbox company configuration/iu)).toBeVisible();
  await publishSandboxCompanyConfiguration(page);
  await navigateInApp(page, '/estimates/estimate-1048');
  await page.getByRole('button', { name: 'Calculate & check policy' }).click();
  await expect(page.getByText('Company configuration required', { exact: true })).toBeVisible();
  await expect(page.getByText(/pressure-wash-flatwork/u)).toBeVisible();
});
