// @ts-check
// Feature: meal photos in chat. All network mocked (Supabase + /api/claude).
const { test, expect } = require('@playwright/test');

const SK = 'nutritrack_v5';
const TODAY = new Date().toLocaleDateString('en-GB');
const SETTINGS_OK = { tdee: 2200, calMin: 1600, calMax: 1900, protMin: 120, protMax: 160, startWeight: 85, goalWeight: 75, name: 'Test' };
const blob = (meals = []) => ({ settings: SETTINGS_OK, days: [], currentDay: { date: TODAY, meals, activityCalories: 0 }, weightLog: [] });

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
  const session = { user: { id: 'mock-photos', email: 'p@test' } };
  await page.addInitScript(makeInitScript({ session, remoteData: data }));
  await page.goto('/');
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SK, JSON.stringify(data)]);
  await page.goto('/');
  await page.waitForTimeout(1500);
}

// Generate a real 2000x1500 JPEG in the browser and return it as a file payload.
async function makeImage(page, w = 2000, h = 1500) {
  const b64 = await page.evaluate(([w, h]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.fillStyle = '#c66'; x.fillRect(0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }, [w, h]);
  return { name: 'meal.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') };
}

function mockClaude(page, captured) {
  return page.route('**/api/claude', async (route) => {
    captured.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({
        items: [{ name: 'Pasta bowl', calories: 500, protein: 20, carbs: 70, fats: 12 }],
        total_calories: 500, total_protein: 20, message: 'Logged pasta', activity_calories: 0 }) }] }),
    });
  });
}

test.describe('Meal photos', () => {
  test('attach shows preview chip, remove clears it', async ({ page }) => {
    await loadApp(page, blob());
    await page.locator('input[type=file]').setInputFiles(await makeImage(page));
    await expect(page.getByTestId('photo-chip')).toBeVisible();
    await page.getByRole('button', { name: 'Remove photo' }).click();
    await expect(page.getByTestId('photo-chip')).toHaveCount(0);
  });

  test('add-photo button is accessible, 44px', async ({ page }) => {
    await loadApp(page, blob());
    const btn = page.getByRole('button', { name: 'Add photo' });
    await expect(btn).toBeVisible();
    const box = await btn.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('photo alone: sends downscaled image block, logs meal, keeps photo out of synced data', async ({ page }) => {
    const captured = [];
    await mockClaude(page, captured);
    await loadApp(page, blob());
    await page.locator('input[type=file]').setInputFiles(await makeImage(page));
    await expect(page.getByTestId('photo-chip')).toBeVisible();
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Logged pasta').first()).toBeVisible();

    expect(captured).toHaveLength(1);
    const last = captured[0].messages.at(-1);
    expect(Array.isArray(last.content)).toBe(true);
    const imgBlock = last.content.find((b) => b.type === 'image');
    expect(imgBlock.source.media_type).toBe('image/jpeg');
    expect(imgBlock.source.data.length).toBeLessThan(500000);
    const dims = await page.evaluate((d) => new Promise((res) => {
      const i = new Image(); i.onload = () => res([i.width, i.height]); i.src = 'data:image/jpeg;base64,' + d;
    }), imgBlock.source.data);
    expect(Math.max(...dims)).toBeLessThanOrEqual(1024);

    await expect(page.getByTestId('photo-chip')).toHaveCount(0);
    const stored = await page.evaluate((k) => localStorage.getItem(k), SK);
    expect(stored).not.toContain('base64');
    expect(stored.length).toBeLessThan(5000);
    const meal = JSON.parse(stored).currentDay.meals[0];
    expect(meal.name).toBe('Pasta bowl');
    expect(typeof meal.photoId).toBe('string');
    const saved = await page.evaluate(() => JSON.stringify(window.__MOCK__.saveCalls));
    expect(saved).not.toContain('base64');
  });

  test('history re-sent on next turn is text-only', async ({ page }) => {
    const captured = [];
    await mockClaude(page, captured);
    await loadApp(page, blob());
    await page.locator('input[type=file]').setInputFiles(await makeImage(page));
    await page.locator('textarea').fill('big lunch');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Logged pasta').first()).toBeVisible();
    await page.locator('textarea').fill('and a coffee');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => captured.length).toBe(2);
    expect(JSON.stringify(captured[1])).not.toContain('"type":"image"');
    expect(typeof captured[1].messages[0].content).toBe('string');
    expect(captured[1].messages[0].content).toContain('[photo]');
  });

  test('thumbnail on Today row; meals without photo render normally', async ({ page }) => {
    const captured = [];
    await mockClaude(page, captured);
    await loadApp(page, blob([
      { name: 'Old meal', calories: 100, protein: 5, time: '08:00' },
      { name: 'Ghost photo', calories: 200, protein: 9, time: '09:00', photoId: 'missing-id' },
    ]));
    await page.locator('input[type=file]').setInputFiles(await makeImage(page));
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Logged pasta').first()).toBeVisible();
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(page.getByText('Old meal')).toBeVisible();
    await expect(page.getByText('Ghost photo')).toBeVisible();
    await expect(page.locator('img[alt="Old meal"], img[alt="Ghost photo"]')).toHaveCount(0);
    const thumb = page.locator('img[alt="Pasta bowl"]');
    await expect(thumb).toBeVisible();
    const box = await thumb.boundingBox();
    expect(box.width).toBe(40);
    const row = page.getByText('Pasta bowl').locator('..').locator('..');
    await expect(row.locator('button').last()).toHaveAttribute('aria-label', 'Edit Pasta bowl');
  });

  test('unreadable file shows inline error and no chip', async ({ page }) => {
    await loadApp(page, blob());
    await page.locator('input[type=file]').setInputFiles({ name: 'x.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image') });
    await expect(page.getByRole('alert')).toContainText(/photo/i);
    await expect(page.getByTestId('photo-chip')).toHaveCount(0);
  });

  test('oversized file (>15MB) rejected inline', async ({ page }) => {
    await loadApp(page, blob());
    await page.locator('input[type=file]').setInputFiles({ name: 'big.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(16 * 1024 * 1024) });
    await expect(page.getByRole('alert')).toContainText(/too large/i);
  });
});
