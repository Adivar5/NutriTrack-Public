// Unit tests for lib/insights.js. Run: node --test tests/feat-nudge-trend.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { proteinNudge, movingAverage, weeklyRate } from '../lib/insights.js';

const G = { protMin: 120, protMax: 160 };

test('nudge: no goals / exactly met / exceeded -> null', () => {
  assert.equal(proteinNudge({}, 50, 10), null);
  assert.equal(proteinNudge(null, 50, 10), null);
  assert.equal(proteinNudge({ protMin: 0 }, 0, 10), null);
  assert.equal(proteinNudge(G, 120, 10), null);
  assert.equal(proteinNudge(G, 130, 10), null);
});
test('nudge: suggestion covers remaining, smallest first', () => {
  assert.match(proteinNudge(G, 108, 10), /^12g protein to go — a Greek yogurt/);
  assert.match(proteinNudge(G, 105, 10), /^15g protein to go — a Greek yogurt/);
  assert.match(proteinNudge(G, 104, 10), /^16g protein to go — a tuna can/);
  assert.match(proteinNudge(G, 88, 10), /^32g protein to go — 150g chicken/);
  assert.match(proteinNudge(G, 0, 10), /^120g protein to go — two /);
});
test('nudge: fractional totals round remaining up', () => {
  assert.match(proteinNudge(G, 107.5, 10), /^13g protein to go/);
});
test('nudge: evening prefix from 17:00', () => {
  assert.ok(!proteinNudge(G, 88, 16).startsWith('Evening'));
  assert.ok(proteinNudge(G, 88, 17).startsWith('Evening check: 32g protein to go'));
});

test('movingAverage edge cases', () => {
  assert.deepEqual(movingAverage([], 3), []);
  assert.deepEqual(movingAverage([5], 3), [5]);
  assert.deepEqual(movingAverage([4, 6], 3), [5, 5]);
  assert.deepEqual(movingAverage([3, 6, 9, 12], 3), [4.5, 6, 9, 10.5]);
});
test('movingAverage does not mutate input', () => {
  const src = [1, 2, 3];
  movingAverage(src, 3);
  assert.deepEqual(src, [1, 2, 3]);
});

const e = (date, weight) => ({ date, weight });
test('weeklyRate: null for empty / few / short span', () => {
  assert.equal(weeklyRate([]), null);
  assert.equal(weeklyRate(undefined), null);
  assert.equal(weeklyRate([e('01/01/2026', 80)]), null);
  assert.equal(weeklyRate([e('01/01/2026', 80), e('20/01/2026', 79)]), null);
  assert.equal(weeklyRate([e('01/01/2026', 80), e('03/01/2026', 79.9), e('05/01/2026', 79.8)]), null);
});
test('weeklyRate: exact slope, regular and irregular spacing', () => {
  const reg = [e('01/01/2026', 80), e('08/01/2026', 79.6), e('15/01/2026', 79.2)];
  assert.ok(Math.abs(weeklyRate(reg) + 0.4) < 1e-9);
  const irr = [e('01/01/2026', 80), e('02/01/2026', 79.9), e('09/01/2026', 79.3)];
  const r = weeklyRate(irr);
  assert.ok(r < 0 && r > -1);
});
test('weeklyRate: uses real dates regardless of input order, ignores invalid', () => {
  const rows = [e('15/01/2026', 79.2), e('bad', 50), e('31/02/2026', 10), e('01/01/2026', 80), e('08/01/2026', 79.6), e('05/01/2026', NaN)];
  assert.ok(Math.abs(weeklyRate(rows) + 0.4) < 1e-9);
});
test('weeklyRate: same-day duplicates tolerated; all-same-day null', () => {
  const dup = [e('01/01/2026', 80), e('01/01/2026', 80), e('08/01/2026', 79.6), e('15/01/2026', 79.2)];
  assert.ok(weeklyRate(dup) < 0);
  assert.equal(weeklyRate([e('01/01/2026', 80), e('01/01/2026', 81), e('01/01/2026', 82)]), null);
});
test('weeklyRate: only last 28 days of the series count', () => {
  const rows = [e('01/01/2025', 100), e('01/02/2026', 80), e('08/02/2026', 80), e('15/02/2026', 80)];
  assert.ok(Math.abs(weeklyRate(rows)) < 1e-9);
});

test('index.html inline helper block is identical to lib/insights.js', () => {
  const grab = (s) => {
    const m = /\/\/ \[insights:helpers\]([\s\S]*?)\/\/ \[\/insights:helpers\]/.exec(s.replace(/\r\n/g, '\n'));
    assert.ok(m, 'markers missing');
    return m[1].replace(/^export /gm, '').trim();
  };
  const lib = grab(fs.readFileSync(new URL('../lib/insights.js', import.meta.url), 'utf8'));
  const html = grab(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
  assert.equal(html, lib);
});
