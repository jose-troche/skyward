import { expect, test } from '@playwright/test';
import { createSession, openConsole, setSpeed } from './helpers';

test.describe('Independent safety nets', () => {
  test('scenario 3: with Separation off there is no advisory, yet the SafetyNet DO raises a conflict alert', async ({ page, request, browser }) => {
    const code = await createSession(request, '03-agents-off');
    await setSpeed(browser, code, 4);
    await openConsole(page, code, 'CTR-NW');
    const ca = page.getByTestId('alert-CA');
    await expect(ca).toBeVisible({ timeout: 150_000 });
    await expect(ca).toHaveAttribute('data-flights', /AAL202.*DAL101|DAL101.*AAL202/);
    await expect(page.locator('[data-testid=advisory][data-source=separation]')).toHaveCount(0);
    // acknowledge collapses it
    await ca.getByTestId('alert-ack').click();
    await expect(ca).toHaveClass(/acked/);
  });

  test('scenario 6: runway alert after a conflicting line-up clearance', async ({ page, request }) => {
    const code = await createSession(request, '06-runway-incursion');
    await openConsole(page, code, 'TWR');
    await expect(page.getByTestId('alert-RWY')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('alert-RWY')).toContainText('27L');
  });

  test('scenario 7: emergency is highlighted on every console', async ({ browser, request }) => {
    const code = await createSession(request, '07-emergency');
    await setSpeed(browser, code, 4);
    const a = await (await browser.newContext()).newPage();
    const b = await (await browser.newContext()).newPage();
    await openConsole(a, code, 'CTR-NW', 'nw');
    await openConsole(b, code, 'TWR', 'twr');
    for (const p of [a, b]) {
      await expect(p.getByTestId('alert-EMERG')).toContainText('DAL707', { timeout: 60_000 });
    }
    // Agents reprioritize: the owning console gets an emergency advisory for DAL707
    await expect(a.locator('[data-testid=advisory]').filter({ hasText: 'DAL707' }).first()).toBeVisible({ timeout: 30_000 });
  });

  test('scenario 9: readback mismatch alert', async ({ page, request }) => {
    const code = await createSession(request, '09-wrong-readback');
    await openConsole(page, code, 'CTR-NW');
    await expect(page.getByTestId('alert-READBACK')).toContainText('issued 11,000, read back 10,000', { timeout: 40_000 });
  });
});
