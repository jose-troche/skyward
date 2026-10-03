import { expect, test } from '@playwright/test';
import { createSession, openConsole, setSpeed } from './helpers';

test.describe('Multiplayer (scenario 10)', () => {
  test('handoff proposed, accepted by the receiving human, both consoles agree within one sweep', async ({ browser, request }) => {
    const code = await createSession(request, '10-multiplayer-handoff');
    await setSpeed(browser, code, 2);
    const nw = await (await browser.newContext()).newPage();
    const app = await (await browser.newContext()).newPage();
    await openConsole(nw, code, 'CTR-NW', 'nancy');
    await openConsole(app, code, 'APP', 'arturo');
    // presence: each sees who holds which position; held positions are disabled in the picker
    await expect(app.getByTestId('presence')).toContainText('CTR-NW: nancy');
    await expect(nw.getByTestId('position-select').locator('option[value=APP]')).toBeDisabled();

    await expect(nw.locator('[data-testid=strip][data-callsign=JBU1010]')).toHaveAttribute('data-owner', 'CTR-NW');
    const accept = app.locator('[data-testid=strip][data-callsign=JBU1010]').getByTestId('handoff-accept');
    await expect(accept).toBeVisible({ timeout: 120_000 });
    await expect(nw.locator('[data-testid=strip][data-callsign=JBU1010]')).toContainText('Handoff to APP proposed');
    await accept.click();
    // Ownership moved: APP owns it, CTR-NW no longer lists it, within one sweep (4.8 s)
    await expect(app.locator('[data-testid=strip][data-callsign=JBU1010]')).toHaveAttribute('data-owner', 'APP', { timeout: 4_800 });
    await expect(nw.locator('[data-testid=strip][data-callsign=JBU1010]')).toHaveCount(0, { timeout: 4_800 });
    await expect(app.getByTestId('comms-log')).toContainText('JBU1010, contact Atlanta Approach');
  });

  test('a held position cannot be claimed twice', async ({ browser, request }) => {
    const code = await createSession(request, 'free-light', { seed: 3 });
    const one = await (await browser.newContext()).newPage();
    const two = await (await browser.newContext()).newPage();
    await openConsole(one, code, 'APP', 'first');
    await two.addInitScript(([c]) => { localStorage.setItem('skyward.name', 'second'); localStorage.setItem(`skyward.pos.${c}`, 'APP'); }, [code]);
    await two.goto(`/#/s/${code}`);
    await expect(two.getByTestId('toast')).toContainText('APP is held by first');
  });
});
