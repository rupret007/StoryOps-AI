import { expect, type Locator, type Page } from '@playwright/test';
import type { SandboxServiceCode } from '../../src/state/model';

type SetupOptions = {
  businessName?: string;
  ownerName?: string;
  postalCode?: string;
  services?: SandboxServiceCode[];
};

const serviceLabels: Record<SandboxServiceCode, string> = {
  'pressure-wash-flatwork': 'Driveway and flatwork pressure wash',
  'soft-wash-house': 'House exterior soft wash',
  'gutter-cleaning': 'Gutter and downspout cleaning',
  'roof-washing': 'Roof soft wash',
  'window-cleaning': 'Window cleaning',
};

export async function completeFirstRunSetup(page: Page, options: SetupOptions = {}): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tell WashOps who it works for.' })).toBeVisible();

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

export async function publishSandboxCompanyConfiguration(page: Page): Promise<void> {
  await page.goto('/setup');
  await expect(
    page.getByRole('heading', { name: 'Configure the company without changing source code.' }),
  ).toBeVisible();

  const ensurePublicationTab = async () => {
    const publicationHeader = page.getByRole('heading', { name: /publication gate/i });
    if (await publicationHeader.isVisible()) return;

    const reviewTab = page.getByRole('button', { name: 'Review & publish' });
    await expect(reviewTab).toBeVisible();
    await reviewTab.click();
    await expect(publicationHeader).toBeVisible();
  };

  const createDraft = page.getByRole('button', { name: 'Create review draft' });
  if (await createDraft.isVisible()) {
    await createDraft.click();
    await expect(page.getByRole('heading', { name: 'Crew and permissions' })).toBeVisible();
    await expect(page.getByText(/Synthetic rehearsal/iu).first()).toBeVisible();
    await ensurePublicationTab();
  } else {
    await ensurePublicationTab();
  }

  const publish = page.getByRole('button', { name: 'Publish sandbox snapshot' });
  await expect(publish).toBeVisible();
  if (await publish.isDisabled()) {
    const configurationRevision = page.locator('.configuration-revision');
    const isPublished = await configurationRevision
      .getByText(/published/i)
      .isVisible()
      .catch(() => false);
    const isSandboxSnapshot = await configurationRevision
      .getByText(/sandbox snapshot/i)
      .isVisible()
      .catch(() => false);
    if (isPublished && isSandboxSnapshot) return;
    await expect(publish).toBeEnabled();
  }
  await publish.click();
  await expect(page.locator('.configuration-revision')).toContainText('published');
  await expect(page.locator('.configuration-revision')).toContainText('sandbox snapshot');
}

async function openMobileNavigation(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const menu = page.getByRole('dialog', { name: 'WashOps workspace' });
  await expect(menu).toBeVisible();
  return menu;
}

export async function setSandboxPreviewRole(
  page: Page,
  role: 'owner' | 'dispatcher' | 'technician' | 'customer',
): Promise<void> {
  const desktopRoleSwitcher = page.locator('#role-switcher');
  if (await desktopRoleSwitcher.isVisible()) {
    await desktopRoleSwitcher.selectOption(role);
    return;
  }

  const menu = await openMobileNavigation(page);
  await menu.getByLabel('Preview role').selectOption(role);
}

export async function restartSandboxRehearsal(page: Page): Promise<void> {
  const desktopRestart = page.getByRole('button', {
    name: 'Restart rehearsal',
    exact: true,
  });
  if (await desktopRestart.isVisible()) {
    await desktopRestart.click();
    return;
  }

  const menu = await openMobileNavigation(page);
  await menu.getByRole('button', { name: 'Restart local sandbox rehearsal' }).click();
}
