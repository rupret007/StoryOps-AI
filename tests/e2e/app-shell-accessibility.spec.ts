import { expect, test } from '@playwright/test';
import { completeFirstRunSetup } from './helpers';

test('mobile navigation and command search remain complete and keyboard-contained', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await completeFirstRunSetup(page);

  const menuTrigger = page.getByRole('button', { name: 'Open navigation menu' });
  await expect(menuTrigger).toBeVisible();
  await menuTrigger.focus();
  await menuTrigger.click();

  const menu = page.getByRole('dialog', { name: 'StoryOps workspace' });
  await expect(menu).toBeVisible();
  for (const destination of [
    'Command center',
    'Pipeline',
    'Customers',
    'Dispatch',
    'Field mode',
    'Finance',
    'AI office',
    'Approvals',
    'Operations',
    'Company setup',
    'Integrations',
    'Audit trail',
    'Estimate EST-1048',
  ]) {
    await expect(menu.getByRole('link', { name: new RegExp(destination, 'u') })).toBeVisible();
  }
  await expect(
    menu.getByText(/Role preview changes only this local synthetic rehearsal/u),
  ).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Restart local sandbox rehearsal' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Close navigation menu' })).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(page.locator(':focus')).toContainText(
    /Restart local sandbox rehearsal|Reset showcase data/u,
  );
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(menuTrigger).toBeFocused();

  const searchTrigger = page.getByRole('button', { name: 'Search StoryOps' });
  await searchTrigger.focus();
  await searchTrigger.click();

  const searchDialog = page.getByRole('dialog', { name: 'Search StoryOps' });
  const searchInput = searchDialog.getByRole('textbox', { name: 'Search' });
  await expect(searchInput).toBeFocused();
  await expect(page.locator('.app-shell__chrome')).toHaveAttribute('inert', '');
  await page.keyboard.press('Shift+Tab');
  await expect(
    searchDialog.getByRole('button', { name: /DFW Residential 2026\.07/u }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(searchInput).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(searchDialog).toBeHidden();
  await expect(searchTrigger).toBeFocused();
  await expect(page.locator('.app-shell__chrome')).not.toHaveAttribute('inert', '');
});
