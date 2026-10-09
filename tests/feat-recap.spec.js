// @ts-check
// Weekly recap: on-demand, cached in localStorage, never in the synced blob.
const { test, expect } = require('@playwright/test');

const SK = 'nutritrack_v5';
const RK = 'nutritrack_recap_v1';
const TODAY = new Date().toLocaleDateString('en-GB');
const SETTINGS_OK = { tdee: 2200, calMin: 1600, calMax: 1900, protMin: 120, protMax: 160, startWeight: 85, goalWeight: 75, name: 'Test' };
const day = (date, cal, prot) => ({ date, meals: [], activityCalories: 0, totalCal: cal, totalProt: prot, netCal: cal });

function blob(days) {
  return { settings: SETTINGS_OK, days, currentDay: { date: TODAY, meals: [], activityCalories: 0 }, weightLog: [{ date: '01/09/2026', weight: 84 }] };
}

function makeInitScript({ session, remoteData }) {
  return `
    (() => {
      const mock = { session: ${JSON.stringify(session)}, userData: ${JSON.stringify(remoteData)}, saveCalls: [], loadCalls: [] };
      window.__MOCK__ = mock;
      const client = {
        auth: {
          async getSession() { return { data: { session: mock.session } }; },
          onAuthStateChange() { return { data: { subscription: { unsubscribe(){} } } }; },
        },
        from() {
          return {
            select() { return this; }, eq() { return this; },
            async single() {
              mock.loadCalls.push(Date.now());
              if (mock.userData) return { data: { data: mock.userData }, error: null };
              return { data: null, error: { code: 'PGRST116' } };
            },
            async upsert(row) { mock.saveCalls.push({ at: Date.now(), data: row.data }); mock.userData = row.data; return { error: null }; },
          };
        },
      };
      Object.defineProperty(window, 'supabase', { configurable: true, get(){ return { createClient: () => client }; }, set(){} });
    })();
  `;
}

const RECAP_TEXT = 'You averaged 1750 kcal, inside your range.\n\nProtein missed on Tuesday.\n\nTry a protein snack at 4pm.';
const DAYS = [day('01/09/2026', 1800, 130), day('02/09/2026', 1700, 100)];
const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function openInsights(page, data, { cached } = {}) {
  const session = { access_token: 'tok', user: { id: 'mock-recap', email: 'r@test' } };
  await page.addInitScript(makeInitScript({ session, remoteData: data }));
  await page.goto('/');
  await page.evaluate(([k, v, rk, rv]) => {
    localStorage.setItem(k, v);
    if (rv) localStorage.setItem(rk, rv); else localStorage.removeItem(rk);
  }, [SK, JSON.stringify(data), RK, cached ? JSON.stringify(cached) : '']);
  await page.goto('/');
  await page.waitForTimeout(1200);
  await page.locator('button').filter({ hasText: /^Insights$/ }).first().click();
}

// Mocks /api/recap and returns the array of parsed request bodies.
async function trackApi(page, handler) {
  const calls = [];
  await page.route('**/api/recap', async route => {
    calls.push(JSON.parse(route.request().postData() || '{}'));
    await handler(route, calls.length);
  });
  return calls;
}

test.describe('Weekly recap', () => {
  test('button -> loading -> recap renders, is cached, and not in synced data', async ({ page }) => {
    const calls = await trackApi(page, async route => {
      await new Promise(r => setTimeout(r, 1500));
      await route.fulfill(json(200, { recap: RECAP_TEXT }));
    });
    await openInsights(page, blob(DAYS));
    await page.getByRole('button', { name: 'Write my weekly recap' }).click();
    await expect(page.getByRole('status')).toContainText('Writing your recap');
    await expect(page.getByText('Protein missed on Tuesday.')).toBeVisible();
    await expect(page.getByText(/^Generated /)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();

    expect(calls.length).toBe(1);
    expect(calls[0].days.length).toBe(2);
    expect(calls[0].settings.tdee).toBe(2200);

    const cached = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), RK);
    expect(cached.text).toBe(RECAP_TEXT);
    expect(typeof cached.generatedAt).toBe('string');
    expect(typeof cached.daysHash).toBe('string');

    const synced = await page.evaluate(() => JSON.stringify(window.__MOCK__.saveCalls) + JSON.stringify(window.__MOCK__.userData));
    expect(synced).not.toContain('Protein missed');
    expect(synced).not.toContain('recap');
  });

  test('reload shows cached recap without a network call', async ({ page }) => {
    const calls = await trackApi(page, route => route.fulfill(json(200, { recap: 'x' })));
    await openInsights(page, blob(DAYS), { cached: { text: RECAP_TEXT, generatedAt: new Date().toISOString(), daysHash: '1' } });
    await expect(page.getByText('Protein missed on Tuesday.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await page.waitForTimeout(300);
    expect(calls.length).toBe(0);
  });

  test('error shows inline message and Retry recovers', async ({ page }) => {
    const calls = await trackApi(page, (route, n) => n === 1
      ? route.fulfill(json(502, { error: 'Anthropic API error' }))
      : route.fulfill(json(200, { recap: RECAP_TEXT })));
    await openInsights(page, blob(DAYS));
    await page.getByRole('button', { name: 'Write my weekly recap' }).click();
    await expect(page.getByRole('alert')).toContainText('Anthropic API error');
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByText('Try a protein snack at 4pm.')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(calls.length).toBe(2);
  });

  test('zero archived days -> explanation, no button, no call', async ({ page }) => {
    const calls = await trackApi(page, route => route.fulfill(json(200, { recap: 'x' })));
    await openInsights(page, blob([]));
    await expect(page.getByText(/build history/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Write my weekly recap' })).toHaveCount(0);
    expect(calls.length).toBe(0);
  });

  test('no horizontal overflow at 375px and button is 44px tall', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await openInsights(page, blob(DAYS));
    const box = await page.getByRole('button', { name: 'Write my weekly recap' }).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});
