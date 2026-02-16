import { test, expect } from '@playwright/test';

test('online lobby loads and rooms endpoint reachable', async ({ page }) => {
  await page.goto('/');

  // Open lobby
  await page.getByRole('button', { name: /Online Multiplayer/i }).click();

  // Expect basic UI present
  await expect(page.getByText(/Online Multiplayer/i)).toBeVisible();

  // Either we have a server configured, or we show the missing-env message.
  const hasServerLine = await page.getByText(/Server:/i).first().isVisible().catch(() => false);
  if (!hasServerLine) {
    await expect(page.getByText(/Missing VITE_SERVER_URL/i)).toBeVisible();
    return;
  }

  await expect(page.getByRole('button', { name: /Refresh Rooms/i })).toBeVisible();
  await page.getByRole('button', { name: /Refresh Rooms/i }).click();
});
