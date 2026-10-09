// @ts-check
// Protein nudge (Today) + smoothed weight trend (Weight). Supabase and /api/* mocked.
const { test, expect } = require('@playwright/test');

const SK = 'nutritrack_v5';
const TODAY = new Date().toLocaleDateString('en-GB');
const SETTINGS = { tdee: 2200, calMin: 1600, calMax: 1900, protMin: 120, protMax: 160, startWeight: 85, goalWeight: 75, name: 'Test' };

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-GB');
}

function blob({ protein = 0, settings = SETTINGS, weightLog = [] } = {}) {
  const meals = protein > 0
    ? [{ id: 1, name: 'Lunch item', calories: 500, protein, carbs: 30, fats: 12, time: '12:00' }]
    : [];
  return { settings, days: [], currentDay: { date: TODAY, meals, activityCalories: 0 }, weightLog };
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

async function loadAppWith(page, data) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const session = { user: { id: 'mock-nudge', email: 'nudge@test' } };
  await page.addInitScript(makeInitScript({ session, remoteData: data }));
  await page.goto('/');
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SK, JSON.stringify(data)]);
  await page.goto('/');
  await page.waitForTimeout(1500);
}

async function openTab(page, name) {
  await page.locator('button').filter({ hasText: new RegExp(`^${name}$`) }).first().click();
  await page.waitForTimeout(300);
}

const NUDGE = '[data-test="protein-nudge"]';
const weights4 = () => [
  { date: daysAgo(21), weight: 80 },
  { date: daysAgo(14), weight: 79.6 },
  { date: daysAgo(7), weight: 79.2 },
  { date: daysAgo(0), weight: 78.8 },
];

test.describe('Protein nudge', () => {
  test('shows remaining grams and suggestion when protein is short', async ({ page }) => {
    await loadAppWith(page, blob({ protein: 88 }));
    await openTab(page, 'Today');
    await expect(page.locator(NUDGE)).toHaveText(/^(Evening check: )?32g protein to go — 150g chicken breast/);
  });

  test('absent when protMin is met exactly or exceeded', async ({ page }) => {
    await loadAppWith(page, blob({ protein: 120 }));
    await openTab(page, 'Today');
    await expect(page.locator('[data-test="macros-row"]')).toBeVisible();
    await expect(page.locator(NUDGE)).toHaveCount(0);
  });

  test('absent when no protein goal is set', async ({ page }) => {
    await loadAppWith(page, blob({ protein: 10, settings: { ...SETTINGS, protMin: 0, protMax: 0 } }));
    await openTab(page, 'Today');
    await expect(page.locator('[data-test="macros-row"]')).toBeVisible();
    await expect(page.locator(NUDGE)).toHaveCount(0);
  });

});

test.describe('Weight trend', () => {
  test('dashed trend path, legend and rate line with >=3 entries over >=7 days', async ({ page }) => {
    await loadAppWith(page, blob({ weightLog: weights4() }));
    await openTab(page, 'Weight');
    const trend = page.locator('[data-test="trend-line"]');
    await expect(trend).toHaveCount(1);
    await expect(trend).toHaveAttribute('stroke-dasharray', '4 4');
    await expect(page.locator('[data-test="trend-legend"]')).toContainText('Weigh-ins');
    await expect(page.locator('[data-test="trend-legend"]')).toContainText('Trend');
    await expect(page.locator('[data-test="trend-rate"]')).toHaveText('Trend: -0.4 kg/week');
    await expect(page.locator('svg[role="img"]').first()).toHaveAttribute('aria-label', /trend: -0\.4 kg\/week/);
  });

  test('rate line hidden when span < 7 days, dashed line still drawn', async ({ page }) => {
    const wl = [{ date: daysAgo(4), weight: 80 }, { date: daysAgo(2), weight: 79.8 }, { date: daysAgo(0), weight: 79.7 }];
    await loadAppWith(page, blob({ weightLog: wl }));
    await openTab(page, 'Weight');
    await expect(page.locator('[data-test="trend-line"]')).toHaveCount(1);
    await expect(page.locator('[data-test="trend-rate"]')).toHaveCount(0);
  });

  test('rate line hidden with only two entries', async ({ page }) => {
    const wl = [{ date: daysAgo(10), weight: 80 }, { date: daysAgo(0), weight: 79 }];
    await loadAppWith(page, blob({ weightLog: wl }));
    await openTab(page, 'Weight');
    await expect(page.locator('[data-test="trend-rate"]')).toHaveCount(0);
  });

  test('no horizontal overflow at 375px on Today and Weight', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await loadAppWith(page, blob({ protein: 88, weightLog: weights4() }));
    for (const tab of ['Today', 'Weight']) {
      await openTab(page, tab);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over).toBeLessThanOrEqual(0);
    }
  });
});
