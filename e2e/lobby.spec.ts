import { expect, test } from '@playwright/test';

test.describe('Lobby', () => {
  test('shows the permanent simulation notice, scenarios and free-tier usage', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('sim-notice')).toContainText('SIMULATION — NOT FOR OPERATIONAL USE');
    await expect(page.getByTestId('lobby')).toBeVisible();
    const options = page.getByTestId('scenario-select').locator('option');
    await expect(options).toHaveCount(12);
    await page.getByTestId('scenario-select').selectOption('01-head-on');
    await expect(page.getByTestId('scenario-desc')).toContainText('5 min before loss of separation');
    for (const m of ['doRequests', 'doRowsWritten', 'doDurationGbS', 'workerRequests', 'aiNeurons']) {
      await expect(page.getByTestId(`usage-${m}`)).toBeVisible();
    }
  });

  test('creates a session and opens the console', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('name-input').fill('alice');
    await page.getByTestId('scenario-select').selectOption('free-light');
    await page.getByTestId('create-session').click();
    await expect(page).toHaveURL(/#\/s\/[A-Z0-9]{6}$/);
    await expect(page.getByTestId('sim-notice')).toBeVisible();
    await expect(page.getByTestId('scope')).toBeVisible();
    await expect(page.getByTestId('connection')).toHaveText('linked');
    await expect(page.getByTestId('scenario-name')).toHaveText('Free play · light traffic');
  });

  test('rejects an invalid room code', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('join-code').fill('x');
    await page.getByTestId('join-session').click();
    await expect(page.getByTestId('toast')).toContainText('valid room code');
  });
});
