import { expect, test } from '@playwright/test';
import { completeFirstRunSetup } from './helpers';

test('sandbox command center shows derived ops holds instead of invented KPIs', async ({
  page,
}) => {
  await completeFirstRunSetup(page);

  await expect(page.getByRole('heading', { name: 'Good morning, Jeff.' })).toBeVisible();
  await expect(page.getByText(/Synthetic sandbox workspace/u)).toBeVisible();
  await expect(page.getByLabel('Workspace record counts')).toBeVisible();
  await expect(page.getByText('New leads', { exact: true })).toBeVisible();
  await expect(page.getByText('Pending approvals', { exact: true })).toBeVisible();
  await expect(page.getByText('Open receivables', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workspace visits' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Owner action queue' })).toBeVisible();
  await expect(page.getByText('Review held actions')).toBeVisible();
  await expect(page.getByText('Qualify new leads')).toBeVisible();
  await expect(page.getByText('JOB-1048')).toBeVisible();
  await expect(page.getByText('JOB-1032')).toBeVisible();
  await expect(page.getByText('Not dispatch evidence', { exact: true })).toBeVisible();
  await expect(page.getByText(/sandbox weather · not dispatch evidence/u).first()).toBeVisible();

  await expect(page.getByText('$4,862')).toHaveCount(0);
  await expect(page.getByText('$7,348')).toHaveCount(0);
  await expect(page.getByText('58.7%')).toHaveCount(0);
  await expect(page.getByText('$8,420')).toHaveCount(0);
  await expect(page.getByText('14 active opportunities')).toHaveCount(0);
  await expect(page.getByText('Demo route packet prepared')).toHaveCount(0);
  await expect(page.getByText('Projected July operating profit')).toHaveCount(0);
  await expect(page.getByText('Weekly equipment inspection')).toHaveCount(0);

  await page.getByRole('link', { name: /Review held actions/u }).click();
  await expect(
    page.getByRole('heading', { name: 'Approve the exact action—not a vague intention' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Negative review response' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'August gutter reminder' })).toBeVisible();

  await page.getByRole('link', { name: 'Command center' }).click();
  await expect(page.getByRole('heading', { name: 'Good morning, Jeff.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Owner action queue' })).toBeVisible();
});
