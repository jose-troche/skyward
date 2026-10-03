import { expect, test } from '@playwright/test';
import { createSession, openConsole } from './helpers';

test.describe('Supervisor', () => {
  test('agent switches, pause/resume, speed and workload view', async ({ page, request }) => {
    const code = await createSession(request, '01-head-on', { seed: 21 });
    await openConsole(page, code, 'SUP');
    const sup = page.getByTestId('supervisor');
    await expect(sup).toBeVisible();
    for (const p of ['CTR-NW', 'CTR-SE', 'APP', 'TWR']) await expect(sup.getByTestId(`sup-pos-${p}`)).toBeVisible();
    // Separation advisories appear, then vanish when the agent is switched off
    await expect(page.locator('[data-testid=advisory][data-source=separation]').first()).toBeVisible({ timeout: 30_000 });
    const toggle = sup.getByTestId('agent-toggle-separation');
    await expect(toggle).toHaveClass(/on/);
    await toggle.click();
    await expect(sup.getByTestId('agent-toggle-separation')).not.toHaveClass(/on/);
    await expect(page.locator('[data-testid=advisory][data-source=separation]')).toHaveCount(0);
    await expect(page.getByTestId('comms-log')).toContainText('separation agent switched OFF');
    // Stub agents from the full roster are listed but cannot be switched on
    await expect(sup.getByTestId('agent-toggle-nationalFlow')).toBeDisabled();
    // Pause / resume / speed
    await sup.getByTestId('sup-pause').click();
    await expect(page.getByTestId('speed-chip')).toHaveText('PAUSED');
    await sup.getByTestId('sup-resume').click();
    await sup.getByTestId('sup-speed-2').click();
    await expect(page.getByTestId('speed-chip')).toHaveText('x2');
  });

  test('non-supervisors cannot use supervisor controls', async ({ page, request }) => {
    const code = await createSession(request, 'free-light', { seed: 22 });
    await openConsole(page, code, 'APP');
    await expect(page.getByTestId('supervisor')).toBeHidden();
    await page.evaluate(() => (window as any).__skyward.conn.send({ v: 1, type: 'sim.control', action: 'pause' }));
    await expect(page.getByTestId('toast')).toContainText('Supervisor only');
  });
});
