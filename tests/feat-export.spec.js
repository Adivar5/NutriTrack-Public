// @ts-check
// Data export: mocked Supabase, no network. Export must be read-only.
const { test, expect } = require('@playwright/test');
const fs = require('fs');

const SK = 'nutritrack_v5';
const TODAY = new Date().toLocaleDateString('en-GB');
const SETTINGS_OK = { tdee: 2200, calMin: 1600, calMax: 1900, protMin: 120, protMax: 160, startWeight: 85, goalWeight: 75, name: 'Test' };

const BLOB = {
  settings: SETTINGS_OK,
  days: [
    { date: '01/01/2026', meals: [
      { name: 'שקשוקה', calories: 400, protein: 20, carbs: 10, fats: 25, time: '08:00' },
      { name: '=HYPERLINK("x")', calories: 100, protein: 1, time: '12:00' },
    ], activityCalories: 150, totalCal: 500, totalProt: 21, netCal: 350 },
    { date: '02/01/2026', totalCal: 1500, totalProt: 90, netCal: 1500, activityCalories: 0 },
  ],
  currentDay: { date: TODAY, meals: [], activityCalories: 0 },
  weightLog: [{ date: '01/01/2026', weight: 80 }],
};

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

async function openSettings(page) {
  const session = { user: { id: 'mock-export', email: 'e@test' } };
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.addInitScript(makeInitScript({ session, remoteData: BLOB }));
  await page.goto('/');
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SK, JSON.stringify(BLOB)]);
  await page.goto('/');
  await page.waitForTimeout(1500);
  await page.locator('nav button').filter({ hasText: /^Settings$/ }).click();
  await expect(page.getByText('Your data')).toBeVisible();
}

async function downloadText(page, buttonName) {
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: buttonName }).click(),
  ]);
  await expect(page.getByText('Exported 3 days')).toBeVisible();
  const text = fs.readFileSync(await dl.path(), 'utf8');
  return { dl, text };
}

test.describe('Data export', () => {
  test('layout: buttons >=44px, summary, Save Settings kept', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeVisible();
    for (const n of ['Export everything (JSON)', 'Export daily log (CSV)']) {
      const box = await page.getByRole('button', { name: n }).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator('[data-test="export-summary"]')).toHaveText('3 days · 2 meals · 1 weigh-ins');
  });

  test('JSON export downloads seeded data without mutating storage', async ({ page }) => {
    await openSettings(page);
    const before = await page.evaluate((k) => localStorage.getItem(k), SK);
    const saves = await page.evaluate(() => window.__MOCK__.saveCalls.length);
    const { dl, text } = await downloadText(page, 'Export everything (JSON)');
    expect(dl.suggestedFilename()).toMatch(/^nutritrack-\d{4}-\d{2}-\d{2}\.json$/);
    const o = JSON.parse(text);
    expect(o.app).toBe('NutriTrack');
    expect(o.days.slice(0, 2).map((d) => d.date)).toEqual(['01/01/2026', '02/01/2026']);
    expect(o.days[o.days.length - 1].current).toBe(true);
    expect(o.weightLog).toEqual(BLOB.weightLog);
    expect(await page.evaluate((k) => localStorage.getItem(k), SK)).toBe(before);
    expect(await page.evaluate(() => window.__MOCK__.saveCalls.length)).toBe(saves);
  });

  test('CSV export: header, Hebrew, escaping, injection guard', async ({ page }) => {
    await openSettings(page);
    const { dl, text } = await downloadText(page, 'Export daily log (CSV)');
    expect(dl.suggestedFilename()).toMatch(/\.csv$/);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('date,time,meal,calories,protein_g,carbs_g,fats_g,day_net_kcal,day_activity_kcal');
    expect(lines[1]).toBe('01/01/2026,08:00,שקשוקה,400,20,10,25,350,150');
    expect(lines[2]).toBe(`01/01/2026,12:00,"'=HYPERLINK(""x"")",100,1,,,350,150`);
    expect(lines[3]).toBe('02/01/2026,,,,,,,1500,0');
  });
});
