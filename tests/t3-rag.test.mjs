// T3 RAG unit tests — pure logic in lib/rag.js with mocked fetch.
// Run with: node --test tests/t3-rag.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractQuery,
  searchTzameret,
  searchFoodsdictionary,
  lookupNutritionContext,
  formatContextForPrompt,
} from '../lib/rag.js';

// ─── tiny fetch mock factory ────────────────────────────────────────────────
function mockFetch(routes) {
  // routes: array of {match: RegExp|fn, status, body|arrayBuffer}
  return async (url, opts) => {
    for (const r of routes) {
      const ok = typeof r.match === 'function' ? r.match(url, opts) : r.match.test(url);
      if (!ok) continue;
      if (r.throw) throw r.throw;
      const status = r.status ?? 200;
      const okFlag = status >= 200 && status < 300;
      return {
        ok: okFlag,
        status,
        async json() { return r.body; },
        async text() { return typeof r.body === 'string' ? r.body : JSON.stringify(r.body); },
        async arrayBuffer() {
          if (r.arrayBuffer) return r.arrayBuffer;
          const txt = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
          return new TextEncoder().encode(txt).buffer;
        },
      };
    }
    throw new Error('No mock match for: ' + url);
  };
}

// ─── extractQuery ───────────────────────────────────────────────────────────
test('extractQuery returns latest user message trimmed', () => {
  assert.equal(
    extractQuery([
      { role: 'user', content: '  bread  ' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'eggs and toast' },
    ]),
    'eggs and toast',
  );
});

test('extractQuery returns null on empty / non-array / no user', () => {
  assert.equal(extractQuery([]), null);
  assert.equal(extractQuery(null), null);
  assert.equal(extractQuery([{ role: 'assistant', content: 'hi' }]), null);
  assert.equal(extractQuery([{ role: 'user', content: '   ' }]), null);
});

test('extractQuery truncates at 200 chars', () => {
  const long = 'x'.repeat(500);
  assert.equal(extractQuery([{ role: 'user', content: long }]).length, 200);
});

// ─── searchTzameret ─────────────────────────────────────────────────────────
test('searchTzameret returns [] when resourceId is missing (skip cleanly)', async () => {
  const fetchImpl = mockFetch([]);
  const result = await searchTzameret('bread', undefined, new AbortController().signal, fetchImpl);
  assert.deepEqual(result, []);
});

test('searchTzameret returns records from CKAN payload', async () => {
  const fetchImpl = mockFetch([
    {
      match: /datastore_search/,
      body: { result: { records: [
        { shmmitzrach: 'Pita bread', food_energy: 275, protein: 9, carbohydrates: 55, total_fat: 1.2 },
        { shmmitzrach: 'White bread', food_energy: 265, protein: 8, carbohydrates: 49, total_fat: 3.2 },
      ] } },
    },
  ]);
  const records = await searchTzameret('bread', 'res-id', new AbortController().signal, fetchImpl);
  assert.equal(records.length, 2);
  assert.equal(records[0].shmmitzrach, 'Pita bread');
});

test('searchTzameret returns [] when API returns non-200', async () => {
  const fetchImpl = mockFetch([{ match: /datastore_search/, status: 500, body: {} }]);
  assert.deepEqual(await searchTzameret('x', 'r', new AbortController().signal, fetchImpl), []);
});

test('searchTzameret returns [] when fetch throws (network down)', async () => {
  const fetchImpl = mockFetch([{ match: /datastore_search/, throw: new Error('ECONNRESET') }]);
  assert.deepEqual(await searchTzameret('x', 'r', new AbortController().signal, fetchImpl), []);
});

// ─── searchFoodsdictionary ──────────────────────────────────────────────────
test('searchFoodsdictionary extracts h2 titles from HTML', async () => {
  const html = `
    <html><body>
      <h2 class="result">פיתה לבנה</h2>
      <h2>Whole wheat bread</h2>
      <h2>Bagel</h2>
      <h2>Should be ignored (4th)</h2>
    </body></html>
  `;
  const fetchImpl = mockFetch([{ match: /FoodsSearch/, body: html }]);
  const out = await searchFoodsdictionary('bread', new AbortController().signal, fetchImpl);
  assert.equal(out.source, 'foodsdictionary');
  assert.equal(out.titles.length, 3, 'capped to 3 titles');
  assert.equal(out.titles[1], 'Whole wheat bread');
  assert.match(out.url, /q=bread/);
});

test('searchFoodsdictionary returns null when no h2 hits', async () => {
  const fetchImpl = mockFetch([{ match: /FoodsSearch/, body: '<html><body>nothing here</body></html>' }]);
  assert.equal(await searchFoodsdictionary('x', new AbortController().signal, fetchImpl), null);
});

test('searchFoodsdictionary returns null on non-200', async () => {
  const fetchImpl = mockFetch([{ match: /FoodsSearch/, status: 403, body: '' }]);
  assert.equal(await searchFoodsdictionary('x', new AbortController().signal, fetchImpl), null);
});

test('searchFoodsdictionary returns null when fetch throws', async () => {
  const fetchImpl = mockFetch([{ match: /FoodsSearch/, throw: new Error('blocked') }]);
  assert.equal(await searchFoodsdictionary('x', new AbortController().signal, fetchImpl), null);
});

// ─── lookupNutritionContext (combined parallel) ─────────────────────────────
test('lookupNutritionContext combines both sources', async () => {
  const fetchImpl = mockFetch([
    { match: /datastore_search/, body: { result: { records: [{ shmmitzrach: 'Hummus', food_energy: 166 }] } } },
    { match: /FoodsSearch/,      body: '<h2>חומוס</h2><h2>טחינה</h2>' },
  ]);
  const ctx = await lookupNutritionContext('hummus', { resourceId: 'r', fetchImpl });
  assert.equal(ctx.tzameret.length, 1);
  assert.equal(ctx.foodsdictionary.titles.length, 2);
});

test('lookupNutritionContext returns null when both sources empty', async () => {
  const fetchImpl = mockFetch([
    { match: /datastore_search/, body: { result: { records: [] } } },
    { match: /FoodsSearch/,      body: '<html></html>' },
  ]);
  const ctx = await lookupNutritionContext('zzzunknownfood', { resourceId: 'r', fetchImpl });
  assert.equal(ctx, null);
});

test('lookupNutritionContext returns null when query is empty/null', async () => {
  const fetchImpl = mockFetch([]);
  assert.equal(await lookupNutritionContext('', { fetchImpl }), null);
  assert.equal(await lookupNutritionContext(null, { fetchImpl }), null);
});

test('lookupNutritionContext honours hard timeout (does not hang)', async () => {
  // Both sources never resolve; lookup must reject/skip within timeoutMs.
  const fetchImpl = (url, opts) => new Promise((_, reject) => {
    opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const t0 = Date.now();
  const ctx = await lookupNutritionContext('bread', { resourceId: 'r', fetchImpl, timeoutMs: 200 });
  const elapsed = Date.now() - t0;
  assert.equal(ctx, null);
  assert.ok(elapsed < 1000, `Should finish quickly, took ${elapsed}ms`);
});

test('lookupNutritionContext still returns Tzameret hits if foodsdictionary fails', async () => {
  const fetchImpl = mockFetch([
    { match: /datastore_search/, body: { result: { records: [{ shmmitzrach: 'Egg', food_energy: 155, protein: 13 }] } } },
    { match: /FoodsSearch/,      throw: new Error('blocked') },
  ]);
  const ctx = await lookupNutritionContext('egg', { resourceId: 'r', fetchImpl });
  assert.equal(ctx.tzameret.length, 1);
  assert.equal(ctx.foodsdictionary, null);
});

// ─── formatContextForPrompt ─────────────────────────────────────────────────
test('formatContextForPrompt returns empty string for null context', () => {
  assert.equal(formatContextForPrompt(null), '');
});

test('formatContextForPrompt produces a labelled block', () => {
  const ctx = {
    tzameret: [{ shmmitzrach: 'Pita', food_energy: 275, protein: 9, carbohydrates: 55, total_fat: 1.2 }],
    foodsdictionary: { url: 'https://x', titles: ['Pita bread'] },
  };
  const out = formatContextForPrompt(ctx);
  assert.match(out, /Tzameret/);
  assert.match(out, /Pita/);
  assert.match(out, /275 kcal/);
  assert.match(out, /foodsdictionary/);
  assert.match(out, /REFERENCE/);
});

test('formatContextForPrompt skips empty tzameret block', () => {
  const out = formatContextForPrompt({ tzameret: [], foodsdictionary: { url: 'https://x', titles: ['A'] } });
  assert.doesNotMatch(out, /Tzameret/);
  assert.match(out, /foodsdictionary/);
});

test('formatContextForPrompt handles weird record field names without crashing', () => {
  const ctx = { tzameret: [{}, { name: 'something' }], foodsdictionary: null };
  const out = formatContextForPrompt(ctx);
  assert.ok(out.length > 0);
  assert.match(out, /something|unknown/);
});
