// Export helper unit tests. Run: node --test tests/feat-export.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildJsonExport, buildCsv, exportCounts, exportFilename } from '../lib/export.js';

const DATA = {
  settings: { tdee: 2200, name: 'A' },
  days: [
    { date: '01/01/2026', meals: [
      { name: 'שקשוקה', calories: 400, protein: 20, carbs: 10, fats: 25, time: '08:00' },
      { name: '=HYPERLINK("x")', calories: 100, protein: 1, time: '12:00' },
      { name: 'Rice, "white"\nbowl', calories: 300, protein: 6, carbs: 60, fats: 1, time: '13:00' },
    ], activityCalories: 150, totalCal: 800, totalProt: 27, netCal: 650 },
    { date: '02/01/2026', totalCal: 1500, totalProt: 90, netCal: 1500, activityCalories: 0 },
  ],
  currentDay: { date: '03/01/2026', meals: [{ name: '-cmd', calories: 50, protein: 0, time: '09:00' }], activityCalories: 0 },
  weightLog: [{ date: '01/01/2026', weight: 80 }],
};

test('json export shape, currentDay last and flagged', () => {
  const now = new Date('2026-01-05T10:00:00Z');
  const o = JSON.parse(buildJsonExport(DATA, now));
  assert.equal(o.app, 'NutriTrack');
  assert.equal(o.exportedAt, now.toISOString());
  assert.equal(o.days.length, 3);
  assert.equal(o.days[2].current, true);
  assert.equal(o.days[0].current, undefined);
  assert.deepEqual(o.weightLog, DATA.weightLog);
  assert.equal(o.settings.tdee, 2200);
});

test('json export does not mutate input', () => {
  const before = JSON.stringify(DATA);
  buildJsonExport(DATA); buildCsv(DATA);
  assert.equal(JSON.stringify(DATA), before);
});

test('csv: BOM, header, escaping, injection guard, empty cells', () => {
  const csv = buildCsv(DATA);
  assert.ok(csv.startsWith('﻿date,time,meal,calories,protein_g,carbs_g,fats_g,day_net_kcal,day_activity_kcal\r\n'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[1], '01/01/2026,08:00,שקשוקה,400,20,10,25,650,150');
  assert.equal(lines[2], `01/01/2026,12:00,"'=HYPERLINK(""x"")",100,1,,,650,150`);
  assert.ok(csv.includes(`"Rice, ""white""\nbowl",300,6,60,1,650,150`));
  assert.ok(csv.includes('02/01/2026,,,,,,,1500,0'));
  assert.ok(csv.includes(`03/01/2026,09:00,'-cmd,50,0,,,,0`));
});

test('csv skips an empty current day; handles empty data', () => {
  const csv = buildCsv({ days: [], currentDay: { date: 'x', meals: [], activityCalories: 0 } });
  assert.equal(csv, '﻿date,time,meal,calories,protein_g,carbs_g,fats_g,day_net_kcal,day_activity_kcal\r\n');
  assert.doesNotThrow(() => buildJsonExport(null));
  assert.doesNotThrow(() => buildCsv(undefined));
});

test('counts and filename', () => {
  assert.deepEqual(exportCounts(DATA), { days: 3, meals: 4, weighIns: 1 });
  assert.equal(exportFilename('csv', new Date(2026, 0, 5)), 'nutritrack-2026-01-05.csv');
});

test('index.html inline helper block is identical to lib/export.js', () => {
  const grab = (s) => {
    const a = s.indexOf('// [feat:export-helpers]');
    const b = s.indexOf('// [/feat:export-helpers]');
    assert.ok(a >= 0 && b > a, 'markers missing');
    return s.slice(a, b).replace(/\r\n/g, '\n').replace(/^export /gm, '');
  };
  const lib = grab(fs.readFileSync(new URL('../lib/export.js', import.meta.url), 'utf8'));
  const html = grab(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
  assert.equal(html, lib);
});
