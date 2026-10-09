// @ts-check
// T2 — Carbs & fats display on the Today tab.
// Verifies: stat chips render, per-meal display shows values + falls back to "—",
// totals sum correctly, edit modal supports carbs/fats with empty-input semantics,
// and legacy meals (without carbs/fats) keep working.
const { test, expect } = require('@playwright/test');

const SK = 'nutritrack_v5';
const TODAY = new Date().toLocaleDateString('en-GB');

const SETTINGS_OK = {
  tdee: 2200, calMin: 1600, calMax: 1900,
  protMin: 120, protMax: 160,
  startWeight: 85, goalWeight: 75, name: 'Test',
};

function blob(meals = []) {
  return {
    settings: SETTINGS_OK,
    days: [],
    currentDay: { date: TODAY, meals, activityCalories: 0 },
    weightLog: [],
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

async function loadAppWith(page, data) {
  const session = { user: { id: 'mock-t2', email: 't2@test' } };
  await page.addInitScript(makeInitScript({ session, remoteData: data }));
  await page.goto('/');
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SK, JSON.stringify(data)]);
  await page.goto('/');
  // wait for Today tab to render (default tab after settings exist)
  await page.waitForTimeout(1500);
}

test.describe('T2: Carbs & fats display', () => {

  test('Empty meals → chips show "—" not "0g"', async ({ page }) => {
    await loadAppWith(page, blob([]));
    // Switch to Today tab.
    const todayTab = page.locator('button').filter({ hasText: /^Today$/ }).first();
    if (await todayTab.count() > 0) await todayTab.click();
    await page.waitForTimeout(300);

    const carbsChip = page.locator('[data-test="stat-carbs"]');
    const fatsChip  = page.locator('[data-test="stat-fats"]');
    await expect(carbsChip).toBeVisible();
    await expect(fatsChip).toBeVisible();
    await expect(carbsChip).toContainText('—');
    await expect(fatsChip).toContainText('—');
  });

  test('Meals with carbs/fats → chips show summed grams', async ({ page }) => {
    const meals = [
      { name: 'Oats', calories: 300, protein: 10, carbs: 50, fats: 6, time: '08:00' },
      { name: 'Chicken', calories: 250, protein: 40, carbs: 0, fats: 10, time: '13:00' },
    ];
    await loadAppWith(page, blob(meals));
    const todayTab = page.locator('button').filter({ hasText: /^Today$/ }).first();
    if (await todayTab.count() > 0) await todayTab.click();
    await page.waitForTimeout(300);

    await expect(page.locator('[data-test="stat-carbs"]')).toContainText('50g');
    await expect(page.locator('[data-test="stat-fats"]')).toContainText('16g');
  });

  test('Mixed meals (some legacy without carbs/fats) → totals reflect only known values; chips render', async ({ page }) => {
    const meals = [
      { name: 'Old meal (legacy)', calories: 400, protein: 20, time: '08:00' }, // no carbs/fats
      { name: 'New meal', calories: 300, protein: 15, carbs: 30, fats: 12, time: '13:00' },
    ];
    await loadAppWith(page, blob(meals));
    const todayTab = page.locator('button').filter({ hasText: /^Today$/ }).first();
    if (await todayTab.count() > 0) await todayTab.click();
    await page.waitForTimeout(300);

    // Chips show totals from known macros only (30g, 12g) — anyMacrosKnown=true so not "—".
    await expect(page.locator('[data-test="stat-carbs"]')).toContainText('30g');
    await expect(page.locator('[data-test="stat-fats"]')).toContainText('12g');
  });

  test('Per-meal row shows "Xg C · Yg F" only when fields exist; legacy meals do not show this line', async ({ page }) => {
    const meals = [
      { name: 'Legacy', calories: 400, protein: 20, time: '08:00' },
      { name: 'WithMacros', calories: 300, protein: 15, carbs: 30, fats: 12, time: '13:00' },
    ];
    await loadAppWith(page, blob(meals));
    const todayTab = page.locator('button').filter({ hasText: /^Today$/ }).first();
    if (await todayTab.count() > 0) await todayTab.click();
    await page.waitForTimeout(300);

    // The "30g C · 12g F" line should appear (for WithMacros).
    await expect(page.getByText('30g C · 12g F')).toBeVisible();
    // Legacy meal does NOT have a "— C · — F" line — feature only shows when at least one macro is present.
    const legacyMacroLine = await page.getByText('— C · — F').count();
    expect(legacyMacroLine).toBe(0);
  });

  test('Edit modal shows carbs/fats inputs; saving updates the meal', async ({ page }) => {
    const meals = [
      { name: 'Test meal', calories: 200, protein: 15, carbs: 20, fats: 8, time: '12:00' },
    ];
    await loadAppWith(page, blob(meals));
    const todayTab = page.locator('button').filter({ hasText: /^Today$/ }).first();
    if (await todayTab.count() > 0) await todayTab.click();
    await page.waitForTimeout(300);

    // Click the edit button (pencil icon next to the meal).
    // It's the only button inside the meal-row beside the totals — find by test attribute or by presence inside the row near the meal name.
    await page.locator('button').filter({ has: page.locator('svg').first() }).nth(0); // baseline; we'll click the edit icon by its container
    // Simpler: click the button near "Test meal".
    const mealRow = page.getByText('Test meal').locator('..').locator('..');
    const editBtn = mealRow.locator('button').last();
    await editBtn.click();
    await page.waitForTimeout(200);

    // Inputs should show current values.
    const carbsInput = page.locator('input[type="number"]').nth(2); // 0=calories, 1=protein, 2=carbs, 3=fats
    const fatsInput  = page.locator('input[type="number"]').nth(3);
    await expect(carbsInput).toHaveValue('20');
    await expect(fatsInput).toHaveValue('8');

    // Edit and save.
    await carbsInput.fill('45');
    await fatsInput.fill('11');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(500);

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('nutritrack_v5')));
    expect(stored.currentDay.meals[0].carbs).toBe(45);
    expect(stored.currentDay.meals[0].fats).toBe(11);
    // Calories/protein preserved.
    expect(stored.currentDay.meals[0].calories).toBe(200);
    expect(stored.currentDay.meals[0].protein).toBe(15);
  });

  test('Empty carbs/fats input on save → field is REMOVED, not set to 0', async ({ page }) => {
    const meals = [
      { name: 'Test meal', calories: 200, protein: 15, carbs: 20, fats: 8, time: '12:00' },
    ];
    await loadAppWith(page, blob(meals));
    const todayTab = page.locator('button').filter({ hasText: /^Today$/ }).first();
    if (await todayTab.count() > 0) await todayTab.click();
    await page.waitForTimeout(300);

    const mealRow = page.getByText('Test meal').locator('..').locator('..');
    await mealRow.locator('button').last().click();
    await page.waitForTimeout(200);

    const carbsInput = page.locator('input[type="number"]').nth(2);
    const fatsInput  = page.locator('input[type="number"]').nth(3);
    await carbsInput.fill('');
    await fatsInput.fill('');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(500);

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('nutritrack_v5')));
    expect('carbs' in stored.currentDay.meals[0], 'carbs key must be absent after clearing').toBe(false);
    expect('fats' in stored.currentDay.meals[0], 'fats key must be absent after clearing').toBe(false);
    // Calories/protein preserved.
    expect(stored.currentDay.meals[0].calories).toBe(200);
    expect(stored.currentDay.meals[0].protein).toBe(15);
  });

  test('Total row shows carbs · fats sub-line when any meal has macros', async ({ page }) => {
    const meals = [
      { name: 'Foo', calories: 400, protein: 20, carbs: 50, fats: 10, time: '08:00' },
      { name: 'Bar', calories: 200, protein: 15, carbs: 25, fats: 5, time: '13:00' },
    ];
    await loadAppWith(page, blob(meals));
    const todayTab = page.locator('button').filter({ hasText: /^Today$/ }).first();
    if (await todayTab.count() > 0) await todayTab.click();
    await page.waitForTimeout(300);

    const total = page.locator('[data-test="meal-total"]');
    await expect(total).toContainText('600 kcal');
    await expect(total).toContainText('35g protein');
    await expect(total).toContainText('75g carbs');
    await expect(total).toContainText('15g fats');
  });

});
