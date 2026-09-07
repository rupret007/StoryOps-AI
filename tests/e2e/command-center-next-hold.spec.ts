import { expect, test } from '@playwright/test';
import { completeFirstRunSetup, publishSandboxCompanyConfiguration } from './helpers';

test('sandbox command center opens the next derived hold', async ({ page }) => {
  await completeFirstRunSetup(page);

  await expect(page.getByRole('heading', { name: 'Do this next' })).toBeVisible();
  await expect(page.getByText('Complete the owner configuration').first()).toBeVisible();
  await expect(page.getByText('Highest-priority hold')).toBeVisible();

  await page.getByRole('link', { name: /Open next: Complete the owner configuration/u }).click();
  await expect(
    page.getByRole('heading', { name: /Configure the company|Tell StoryOps who it works for/u }),
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

  await page.getByRole('link', { name: /Open next: Finish estimate evidence/u }).click();
  await expect(page.getByRole('heading', { name: 'Build a verified estimate' })).toBeVisible();
  await expect(page.getByText('Decimal arithmetic')).toBeVisible();
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
