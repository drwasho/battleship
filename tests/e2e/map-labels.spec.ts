import { test, expect } from '@playwright/test';

test('map labels are roughly centered beneath each board', async ({ page }) => {
  await page.goto('/');

  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  // Wait a tick for layout positioning.
  await page.waitForTimeout(200);

  const own = page.locator('.map-label-own');
  const target = page.locator('.map-label-target');
  await expect(own).toBeVisible();
  await expect(target).toBeVisible();

  const cBox = await canvas.boundingBox();
  const oBox = await own.boundingBox();
  const tBox = await target.boundingBox();
  expect(cBox).toBeTruthy();
  expect(oBox).toBeTruthy();
  expect(tBox).toBeTruthy();

  const cx = cBox!.x + cBox!.width / 2;
  const ownCx = oBox!.x + oBox!.width / 2;
  const targetCx = tBox!.x + tBox!.width / 2;

  // Should be on their respective halves.
  expect(ownCx).toBeLessThan(cx);
  expect(targetCx).toBeGreaterThan(cx);

  // Should not be in extreme corners.
  expect(ownCx).toBeGreaterThan(cBox!.x + cBox!.width * 0.04);
  expect(targetCx).toBeLessThan(cBox!.x + cBox!.width * 0.96);

  // Should be below the boards (roughly lower half of the canvas), but still inside the canvas.
  const ownCy = oBox!.y + oBox!.height / 2;
  const targetCy = tBox!.y + tBox!.height / 2;

  const minY = cBox!.y + cBox!.height * 0.45;
  const maxY = cBox!.y + cBox!.height * 0.98;
  expect(ownCy).toBeGreaterThan(minY);
  expect(ownCy).toBeLessThan(maxY);
  expect(targetCy).toBeGreaterThan(minY);
  expect(targetCy).toBeLessThan(maxY);
});
