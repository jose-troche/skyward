import { expect, test } from '@playwright/test';
import { createSession, openConsole } from './helpers';

test.describe('Advisory loop (scenario 1)', () => {
  test('separation advisory: explain, accept, phraseology, readback', async ({ page, request }) => {
    const code = await createSession(request, '01-head-on');
    await openConsole(page, code, 'CTR-NW');
    const adv = page.getByTestId('advisory').filter({ has: page.locator('[data-source=separation]') }).or(page.locator('[data-testid=advisory][data-source=separation]')).first();
    await expect(adv).toBeVisible({ timeout: 30_000 });
    // Max 3 advisories per position
    expect(await page.getByTestId('advisory').count()).toBeLessThanOrEqual(3);
    await expect(adv.getByTestId('adv-command')).toHaveText(/^(DAL101|AAL202) /);
    // "Why" opens the Explainer sentence (Workers AI or deterministic fallback)
    await adv.getByTestId('adv-why').click();
    await expect(adv.getByTestId('adv-explanation')).not.toHaveText(/Explaining|^$/, { timeout: 30_000 });
    const command = (await adv.getByTestId('adv-command').textContent())!;
    const callsign = command.split(' ')[0];
    await adv.getByTestId('adv-accept').click();
    // Echoed in the comms log as phraseology, then read back by the simulated pilot
    await expect(page.getByTestId('comms-log')).toContainText(`${callsign}, `);
    await expect(page.getByTestId('comms-log').getByTestId('comms-line').filter({ hasText: `, ${callsign}` }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(`[data-testid=advisory][data-source=separation]`)).toHaveCount(0, { timeout: 20_000 });
  });

  test('reject with a reason code removes the advisory', async ({ page, request }) => {
    const code = await createSession(request, '01-head-on', { seed: 77 });
    await openConsole(page, code, 'CTR-NW');
    const adv = page.locator('[data-testid=advisory][data-source=separation]').first();
    await expect(adv).toBeVisible({ timeout: 30_000 });
    const id = await adv.getAttribute('data-id');
    await adv.getByTestId('adv-reason').selectOption('TRAFFIC');
    await adv.getByTestId('adv-reject').click();
    await expect(page.locator(`[data-testid=advisory][data-id="${id}"]`)).toHaveCount(0);
  });

  test('sweep latency is under 300 ms', async ({ page, request }) => {
    const code = await createSession(request, '01-head-on', { seed: 5 });
    await openConsole(page, code, 'OBS');
    await expect.poll(async () => page.evaluate(() => (window as any).__skyward.store.tick), { timeout: 30_000 }).toBeGreaterThan(2);
    const latency = await page.evaluate(() => (window as any).__skyward.store.latencyMs);
    expect(latency).toBeLessThan(300);
  });
});
