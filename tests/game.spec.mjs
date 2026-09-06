import { test, expect } from '@playwright/test';

async function setup(page) {
  await page.route('**/api/leaderboard', r => r.fulfill({ json: { verified: [], rejected: [] } }));
  await page.route('**/api/session', r => r.fulfill({ json: { sessionId: 'test-session' } }));
  await page.goto('/');
  await page.getByPlaceholder('Your name').fill('Player');
  await page.getByRole('button', { name: 'Go on then' }).click();
}

test('false start cannot open a second round before the held response settles', async ({ page }) => {
  let opened = 0;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/rounds', async r => {
    opened++;
    await held;
    await r.fulfill({ json: { roundId: 'one', goToken: 'token' } });
  });
  await page.route('**/api/rounds/one/result', r => r.fulfill({ json: { status: 'void', fault: 'player', note: 'too soon' } }));
  await setup(page);
  await page.locator('.pad').click();
  await expect(page.locator('.pad')).toHaveText('wait for it…');
  await page.locator('.pad').click();
  await page.locator('.pad').click();
  await expect(page.locator('.pad')).toHaveText('settling…');
  expect(opened).toBe(1);
  release();
  await expect(page.locator('.pad')).toContainText('too soon');
});

test('double tap submits once; lost result response can be retried', async ({ page }) => {
  let submissions = 0;
  const payloads = [];
  await page.route('**/api/rounds', r => r.fulfill({ json: { roundId: 'one', goToken: 'token' } }));
  await page.route('**/api/rounds/one/result', async r => {
    submissions++;
    payloads.push(r.request().postDataJSON());
    if (submissions === 1) await r.abort();
    else await r.fulfill({ json: { status: 'valid', ms: 250, note: null } });
  });
  await setup(page);
  await page.locator('.pad').click();
  await expect(page.locator('.pad')).toHaveText('NOW!');
  await page.locator('.pad').dblclick({ delay: 20 });
  await expect(page.getByRole('button', { name: 'Retry saving' })).toBeVisible();
  expect(submissions).toBe(1);
  await page.getByRole('button', { name: 'Retry saving' }).click();
  await expect(page.locator('.chamber.filled')).toHaveCount(1);
  expect(payloads[1]).toEqual(payloads[0]);
});

test('changing player discards an old round response', async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/rounds', async r => {
    await held;
    await r.fulfill({ json: { roundId: 'old', goToken: 'old' } });
  });
  await setup(page);
  await page.locator('.pad').click();
  await page.getByRole('button', { name: 'not Player?' }).click();
  release();
  await expect(page.getByRole('heading', { name: 'Five rounds. Median wins.' })).toBeVisible();
  await expect(page.locator('.pad')).toHaveCount(0);
});

test('five results survive a failed finish request', async ({ page }) => {
  let finishes = 0;
  await page.route('**/api/rounds', r => r.fulfill({ json: { roundId: 'one', goToken: 'token' } }));
  await page.route('**/api/rounds/one/result', r => r.fulfill({ json: { status: 'valid', ms: 250 } }));
  await page.route('**/api/session/test-session/finish', async r => {
    finishes++;
    if (finishes === 1) await r.abort();
    else await r.fulfill({ json: { status: 'verified', median: 250, best: 250, sd: 0, flags: [] } });
  });
  await setup(page);
  for (let i = 0; i < 5; i++) {
    await page.locator('.pad').click();
    await expect(page.locator('.pad')).toHaveText('NOW!');
    await page.locator('.pad').click();
    await expect(page.locator('.chamber.filled')).toHaveCount(i + 1);
  }
  await page.getByRole('button', { name: 'Retry saving' }).click();
  await expect(page.locator('.cert')).toContainText('passed checks');
  expect(finishes).toBe(2);
});
