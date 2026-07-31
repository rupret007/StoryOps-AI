import { expect, test } from '@playwright/test';
import { completeFirstRunSetup } from './helpers';

test('owner can save incomplete setup work and service changes repair package scope', async ({
  page,
}) => {
  await completeFirstRunSetup(page, {
    services: ['pressure-wash-flatwork', 'gutter-cleaning'],
  });
  await page.getByRole('link', { name: 'Open company setup' }).click();

  await expect(
    page.getByRole('heading', { name: 'Configure the company without changing source code.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create review draft' }).click();
  await expect(page.getByRole('heading', { name: 'Crew and permissions' })).toBeVisible();
  await expect(page.getByText(/planning records only/iu)).toBeVisible();
  await expect(page.getByText(/Synthetic rehearsal/iu).first()).toBeVisible();
  await expect(
    page.getByText(/Every required equipment type has an active current inspection/iu),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Pricing & policy' }).click();
  await page.getByLabel(/House exterior soft wash/iu).check();
  await page.getByLabel(/Window cleaning/iu).check();
  await page.getByLabel(/Gutter and downspout cleaning/iu).uncheck();
  await expect(page.getByText(/regenerated from the canonical package policy/iu)).toBeVisible();
  await page.getByRole('button', { name: 'Save draft revision' }).click();

  await page.getByRole('button', { name: 'Review & publish' }).click();
  await expect(page.getByText(/missing enabled-service requirements/iu)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish sandbox snapshot' })).toBeDisabled();
});
