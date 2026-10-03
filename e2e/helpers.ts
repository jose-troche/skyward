import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

export async function createSession(request: APIRequestContext, scenario: string, extra: { seed?: number; traffic?: string } = {}): Promise<string> {
  const res = await request.post('/api/sessions', { data: { scenario, ...extra } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).code as string;
}

/** Opens the console for a session at a given position (pre-seeded via localStorage). */
export async function openConsole(page: Page, code: string, position: string, name = `pw-${position}`) {
  await page.addInitScript(([c, p, n]) => {
    localStorage.setItem('skyward.name', n);
    localStorage.setItem(`skyward.pos.${c}`, p);
  }, [code, position, name]);
  await page.goto(`/#/s/${code}`);
  await expect(page.getByTestId('session-code')).toHaveText(code);
  await expect(page.getByTestId('connection')).toHaveText('linked');
  await expect(page.getByTestId('position-select')).toHaveValue(position);
}

/** Uses a short-lived supervisor console to change sim speed (supervisor-only control). */
export async function setSpeed(browser: Browser, code: string, speed: 1 | 2 | 4) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await openConsole(page, code, 'SUP', 'pw-sup');
  await page.getByTestId(`sup-speed-${speed}`).click();
  await expect(page.getByTestId('speed-chip')).toHaveText(`x${speed}`);
  await ctx.close();
}

export async function simSeconds(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __skyward: { store: { simT: number } } }).__skyward.store.simT);
}
