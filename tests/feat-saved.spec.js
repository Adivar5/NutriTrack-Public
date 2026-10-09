// @ts-check
// Saved meals (favourites): save from edit panel, re-log via chip with no API call.
const { test, expect } = require('@playwright/test');

const SK = 'nutritrack_v5';
const TODAY = new Date().toLocaleDateString('en-GB');
const SETTINGS_OK = {
  tdee: 2200, calMin: 1600, calMax: 1900, protMin: 120, protMax: 160,
  startWeight: 85, goalWeight: 75, name: 'Test',
};

function blob(meals = [], extra = {}) {
  return {
    settings: SETTINGS_OK, days: [],
    currentDay: { date: TODAY, meals, activityCalories: 0 },
    weightLog: [], ...extra,
  };
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

async function loadApp(page, data) {
  const apiCalls = [];
  await page.route('**/api/**', (route) => {
    apiCalls.push(route.request().url());
    route.fulfill({ status: 500, body: '{"error":"blocked in test"}' });
  });
  const session = { user: { id: 'mock-saved', email: 's@test' } };
  await page.addInitScript(makeInitScript({ session, remoteData: data }));
  await page.goto('/');
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SK, JSON.stringify(data)]);
  await page.goto('/');
  await page.waitForTimeout(1200);
  return apiCalls;
}

const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), SK);
const nav = (page, name) => page.getByRole('button', { name, exact: true }).click();

async function openEditPanel(page, name) {
  await nav(page, 'Today');
  await page.getByRole('button', { name: `Edit ${name}` }).click();
}

const OATS = { name: 'Oats', calories: 300, protein: 10, carbs: 50, fats: 6, time: '08:00' };

test.describe('Saved meals', () => {
  test('Add to favourites persists savedMeals; duplicate (case-insensitive) is rejected', async ({ page }) => {
    await loadApp(page, blob([OATS]));
    await openEditPanel(page, 'Oats');
    await page.getByRole('button', { name: 'Add to favourites' }).click();
    await expect(page.getByText('Added to favourites')).toBeVisible();
    let s = await stored(page);
    expect(s.savedMeals).toHaveLength(1);
    expect(s.savedMeals[0]).toMatchObject({ name: 'Oats', calories: 300, protein: 10, carbs: 50, fats: 6 });
    expect(typeof s.savedMeals[0].id).toBe('string');

    // change case in the draft name and add again
    await page.getByRole('textbox').first().fill('OATS');
    await page.getByRole('button', { name: 'Add to favourites' }).click();
    await expect(page.getByText('Already in favourites')).toBeVisible();
    s = await stored(page);
    expect(s.savedMeals).toHaveLength(1);
  });

  test('Cap at 30: oldest dropped', async ({ page }) => {
    const seeded = Array.from({ length: 30 }, (_, i) => ({ id: 'id' + i, name: 'Meal ' + i, calories: 100, protein: 5 }));
    await loadApp(page, blob([OATS], { savedMeals: seeded }));
    await openEditPanel(page, 'Oats');
    await page.getByRole('button', { name: 'Add to favourites' }).click();
    const s = await stored(page);
    expect(s.savedMeals).toHaveLength(30);
    expect(s.savedMeals.find((m) => m.name === 'Meal 0')).toBeUndefined();
    expect(s.savedMeals[29].name).toBe('Oats');
  });

  test('Chip re-logs meal with macros and makes zero API calls', async ({ page }) => {
    const saved = [{ id: 'a1', name: 'Protein shake', calories: 200, protein: 30, carbs: 8, fats: 3 }];
    const apiCalls = await loadApp(page, blob([], { savedMeals: saved }));
    await page.getByRole('button', { name: /Protein shake/ }).first().click();
    await expect(page.getByText('Logged Protein shake', { exact: true })).toBeVisible();
    const s = await stored(page);
    expect(s.currentDay.meals).toHaveLength(1);
    expect(s.currentDay.meals[0]).toMatchObject({ name: 'Protein shake', calories: 200, protein: 30, carbs: 8, fats: 3 });
    expect(s.currentDay.meals[0].time).toMatch(/^\d{2}:\d{2}$/);
    expect(apiCalls).toHaveLength(0);
    await expect(page.getByText(/Today so far/)).toBeVisible();
  });

  test('Edit favourites mode removes a favourite', async ({ page }) => {
    const saved = [
      { id: 'a1', name: 'Protein shake', calories: 200, protein: 30 },
      { id: 'a2', name: 'Toast', calories: 120, protein: 4 },
    ];
    await loadApp(page, blob([], { savedMeals: saved }));
    await page.getByRole('button', { name: 'Edit favourites' }).first().click();
    await page.getByRole('button', { name: 'Remove Toast' }).first().click();
    const s = await stored(page);
    expect(s.savedMeals.map((m) => m.name)).toEqual(['Protein shake']);
  });

  test('Legacy blob without savedMeals loads; normal action does not add the key', async ({ page }) => {
    await loadApp(page, blob([OATS]));
    await expect(page.getByText('What did you eat today?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit favourites' })).toHaveCount(0);
    await openEditPanel(page, 'Oats');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(2000);
    const s = await stored(page);
    expect('savedMeals' in s).toBe(false);
    const remote = await page.evaluate(() => window.__MOCK__.userData);
    expect('savedMeals' in remote).toBe(false);
  });
});
