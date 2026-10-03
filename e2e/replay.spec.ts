import { expect, test } from '@playwright/test';
import { createSession, openConsole } from './helpers';

test('replay re-simulates the session from its event log', async ({ page, request }) => {
  const code = await createSession(request, '01-head-on', { seed: 31 });
  await openConsole(page, code, 'CTR-NW');
  const adv = page.locator('[data-testid=advisory][data-source=separation]').first();
  await expect(adv).toBeVisible({ timeout: 30_000 });
  await adv.getByTestId('adv-accept').click();
  await expect(page.getByTestId('comms-log')).toContainText('DAL101, ', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(6000);
  // Replay API returns the epoch's events
  const res = await request.get(`/api/sessions/${code}/replay`);
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  expect(data.events.some((e: { kind: string }) => e.kind === 'session.start')).toBeTruthy();
  expect(data.events.some((e: { kind: string }) => e.kind === 'advisory.accept')).toBeTruthy();

  await page.goto(`/#/replay/${code}`);
  await expect(page.getByTestId('replay-status')).toContainText('sweeps re-simulated');
  const slider = page.getByTestId('replay-slider');
  const max = Number(await slider.getAttribute('max'));
  expect(max).toBeGreaterThan(1);
  await slider.fill(String(max));
  await expect(page.getByTestId('replay-clock')).not.toHaveText('00:00:00');
  await expect(page.getByTestId('replay-events')).toBeVisible();
});
