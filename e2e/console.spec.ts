import { expect, test } from '@playwright/test';
import { createSession, openConsole } from './helpers';

test.describe('Console interactions', () => {
  test('command line issues a clearance and reports parse errors', async ({ page, request }) => {
    const code = await createSession(request, '01-head-on', { seed: 11 });
    await openConsole(page, code, 'CTR-NW');
    const input = page.getByTestId('command-input');
    await input.fill('DAL101 XYZ');
    await input.press('Enter');
    await expect(page.getByTestId('command-error')).toContainText('Unknown instruction');
    await input.fill('dal101 h090 s420');
    await input.press('Enter');
    await expect(page.getByTestId('command-error')).toHaveText('');
    await expect(page.getByTestId('comms-log')).toContainText('DAL101, turn right heading 090, adjust speed 420 knots');
    await expect(page.getByTestId('comms-log')).toContainText('heading 090, speed 420, DAL101', { timeout: 20_000 });
  });

  test('a controller cannot clear a flight owned by another position', async ({ page, request }) => {
    const code = await createSession(request, '01-head-on', { seed: 12 });
    await openConsole(page, code, 'APP');
    await page.getByTestId('command-input').fill('DAL101 H090');
    await page.getByTestId('command-input').press('Enter');
    await expect(page.getByTestId('toast')).toContainText('owned by CTR-NW');
  });

  test('strips list owned flights; right-click opens the clearance menu', async ({ page, request }) => {
    const code = await createSession(request, '01-head-on', { seed: 13 });
    await openConsole(page, code, 'CTR-NW');
    await expect(page.getByTestId('strip')).toHaveCount(2);
    await page.getByTestId('strip').first().click();
    await expect(page.getByTestId('strip').first()).toHaveClass(/selected/);
    const pt = await page.evaluate(() => (window as any).__skyward.scope.screenOf('AAL202'));
    expect(pt).toBeTruthy();
    await page.mouse.click(pt.x, pt.y, { button: 'right' });
    const menu = page.getByTestId('clearance-menu');
    await expect(menu).toContainText('AAL202');
    await menu.getByRole('button', { name: 'ILS 27R' }).click();
    await expect(page.getByTestId('comms-log')).toContainText('AAL202, cleared ILS runway 27R approach');
  });

  test('theme toggle switches between dark scope and light projector theme', async ({ page, request }) => {
    const code = await createSession(request, 'free-light', { seed: 14 });
    await openConsole(page, code, 'OBS');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('relief briefing renders', async ({ page, request }) => {
    const code = await createSession(request, 'free-light', { seed: 15 });
    await openConsole(page, code, 'APP');
    await page.getByTestId('brief-btn').click();
    await expect(page.getByTestId('brief-text')).not.toHaveText('Generating briefing…', { timeout: 45_000 });
    await expect(page.getByTestId('brief-text')).toContainText(/APP|aircraft|traffic/i);
  });
});
