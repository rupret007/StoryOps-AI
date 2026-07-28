import { expect, type Page } from '@playwright/test';
import type { SandboxServiceCode } from '../../src/state/model';

type SetupOptions = {
  businessName?: string;
  ownerName?: string;
  postalCode?: string;
  services?: SandboxServiceCode[];
};

const serviceLabels: Record<SandboxServiceCode, string> = {
  'pressure-wash-flatwork': 'Pressure washing',
  'soft-wash-house': 'Soft washing',
  'gutter-cleaning': 'Gutter cleaning',
};

export async function completeFirstRunSetup(page: Page, options: SetupOptions = {}): Promise<void> {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Tell StoryOps who it works for.' }),
  ).toBeVisible();

  if (options.businessName) {
    await page.getByLabel('Business name').fill(options.businessName);
  }
  if (options.ownerName) {
    await page.getByLabel('Owner name').fill(options.ownerName);
  }
  if (options.postalCode) {
    await page.getByLabel('Home ZIP code').fill(options.postalCode);
  }
  await page.getByRole('button', { name: 'Continue' }).click();

  const requested = new Set(options.services ?? ['pressure-wash-flatwork', 'gutter-cleaning']);
  for (const [code, label] of Object.entries(serviceLabels) as Array<
    [SandboxServiceCode, string]
  >) {
    const button = page.getByRole('button', { name: new RegExp(label, 'u') });
    const selected = (await button.getAttribute('aria-pressed')) === 'true';
    if (selected !== requested.has(code)) await button.click();
  }
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel(/I understand these settings are local sandbox guardrails/u).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirm the local sandbox scope.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create sandbox profile' }).click();
  const ownerFirstName = (options.ownerName ?? 'Jeff Story').trim().split(/\s+/u)[0];
  await expect(
    page.getByRole('heading', { name: `Good morning, ${ownerFirstName}.` }),
  ).toBeVisible();
}
