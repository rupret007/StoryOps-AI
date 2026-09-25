import { expect, test } from '@playwright/test';
import { completeFirstRunSetup, publishSandboxCompanyConfiguration } from './helpers';

test('sandbox command center opens the next derived hold', async ({ page }) => {
  await completeFirstRunSetup(page);

  const glance = page.getByRole('region', { name: 'Phone glance' });
  await expect(glance).toBeVisible();
  await expect(glance.getByRole('heading', { name: /hold stops work/u })).toBeVisible();
  await expect(glance.getByText('Stops work. See the source for details.')).toBeVisible();
  await expect(glance.getByText(/Do:\s*Record identity/u)).toBeVisible();
  await expect(glance.getByRole('button', { name: 'Copy for SMS' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Do this next' })).toBeVisible();
  await expect(page.getByText('Complete the owner configuration').first()).toBeVisible();
  await expect(
    page.getByText('This hold stops work. Handle it before any decision or follow-up.'),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Do this: Open Owner configuration' }).click();
  await expect(
    page.getByRole('heading', { name: /Configure the company|Tell WashOps who it works for/u }),
  ).toBeVisible();
});

test('published sandbox configuration advances the next hold to estimate evidence', async ({
  page,
}) => {
  await completeFirstRunSetup(page);
  await publishSandboxCompanyConfiguration(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Do this next' })).toBeVisible();
  await expect(page.getByText('Finish estimate evidence').first()).toBeVisible();
  await expect(page.getByText('EST-1048').first()).toBeVisible();
  await expect(
    page.getByText(
      'No P0 item is waiting. This hold is the next thing that still blocks a safe step.',
    ),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Do this: Open Estimate' }).click();
  await expect(page.getByRole('heading', { name: 'Build a verified estimate' })).toBeVisible();
  await expect(page.getByText('Decimal arithmetic')).toBeVisible();
});

test('phone glance fits above the greeting', async ({ page }, testInfo) => {
  testInfo.skip(testInfo.project.name !== 'mobile', 'phone viewport only');
  await completeFirstRunSetup(page);

  const glance = page.getByRole('region', { name: 'Phone glance' });
  const greeting = page.getByRole('heading', { name: 'Good morning, Jeff.' });
  await expect(glance).toBeVisible();
  await expect(greeting).toBeVisible();

  const glanceBox = await glance.boundingBox();
  const greetingBox = await greeting.boundingBox();
  const viewport = page.viewportSize();
  expect(glanceBox).not.toBeNull();
  expect(greetingBox).not.toBeNull();
  expect(glanceBox!.y).toBeLessThan(greetingBox!.y);
  expect(glanceBox!.y + glanceBox!.height).toBeLessThan((viewport?.height ?? 844) * 0.92);
  await expect(
    glance.getByRole('link', { name: 'Do this: Open Owner configuration' }),
  ).toBeVisible();
});

test('operations safety hash lands on the incident hold surface', async ({ page }) => {
  await completeFirstRunSetup(page);
  await page.goto('/operations#safety');

  await expect(page.getByRole('tab', { name: /Safety & incidents/u })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('heading', { name: 'Open incidents' })).toBeVisible();
  await expect(page.getByText(/Near misses remain reportable/u)).toBeVisible();
});
