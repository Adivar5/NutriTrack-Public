// Photos: message validation + handler wiring. node --test tests/feat-photos-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMessages, textOnlyMessages, __limits } from '../lib/validate-messages.js';
import handler from '../api/claude.js';

const img = (over = {}) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD', ...over } });
const user = (content) => ({ role: 'user', content });

test('accepts string and text+image content', () => {
  assert.equal(validateMessages([user('hi')]), null);
  assert.equal(validateMessages([user([img(), { type: 'text', text: 'lunch' }])]), null);
});
test('rejects empty/non-array messages and bad roles', () => {
  assert.ok(validateMessages([]));
  assert.ok(validateMessages('x'));
  assert.ok(validateMessages([{ role: 'system', content: 'x' }]));
});
test('rejects unknown block types', () => {
  assert.ok(validateMessages([user([{ type: 'tool_use' }])]));
});
test('rejects bad media type, non-base64 source, bad base64', () => {
  assert.ok(validateMessages([user([img({ media_type: 'image/gif' })])]));
  assert.ok(validateMessages([user([img({ type: 'url' })])]));
  assert.ok(validateMessages([user([img({ data: 'not base64!!' })])]));
  assert.ok(validateMessages([user([img({ data: '' })])]));
});
test('rejects oversize image and >1 image', () => {
  assert.ok(validateMessages([user([img({ data: 'A'.repeat(__limits.MAX_BASE64_CHARS + 4) })])]));
  assert.ok(validateMessages([user([img(), img()])]));
});
test('textOnlyMessages drops images', () => {
  const out = textOnlyMessages([user([img(), { type: 'text', text: 'pasta' }]), user('x')]);
  assert.deepEqual(out, [user('pasta'), user('x')]);
});

function mockRes() {
  return { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
}
async function run(messages, anthropicCapture) {
  process.env.ALLOWED_EMAILS = 'a@b.c';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ email: 'a@b.c' }) };
    if (String(url).includes('api.anthropic.com')) {
      anthropicCapture.body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{}' }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  try {
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { messages, settings: { tdee: 1, calMin: 1, calMax: 2, protMin: 1, protMax: 2, startWeight: 1 } } }, res);
    return res;
  } finally { globalThis.fetch = realFetch; }
}
test('handler: 400 on invalid image, no upstream call', async () => {
  const cap = {};
  const res = await run([user([img({ media_type: 'image/gif' })])], cap);
  assert.equal(res.code, 400);
  assert.equal(cap.body, undefined);
});
test('handler: valid image forwarded with photo prompt line', async () => {
  const cap = {};
  const res = await run([user([img(), { type: 'text', text: 'lunch' }])], cap);
  assert.equal(res.code, 200);
  assert.equal(cap.body.messages[0].content[0].type, 'image');
  assert.match(cap.body.system, /photo/i);
  assert.equal(cap.body.thinking.type, 'between_tools');
  assert.equal(cap.body.output_config.effort, 'medium');
});

test('handler: meal JSON after an empty thinking block is what the client parses', async () => {
  const meal = '{"items":[{"name":"egg","calories":70,"protein":6}],"total_calories":70,"total_protein":6,"message":"Logged egg","activity_calories":0}';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ email: 'a@b.c' }) };
    if (String(url).includes('api.anthropic.com')) {
      return { ok: true, json: async () => ({ content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: 'Here is the log:\n' + meal },
      ] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { messages: [user('egg')], settings: { tdee: 1, calMin: 1, calMax: 2, protMin: 1, protMax: 2, startWeight: 1 } } }, res);
    assert.equal(res.code, 200);
    const parsed = JSON.parse(res.body.content[0].text);
    assert.equal(parsed.items[0].name, 'egg');
    assert.equal(parsed.total_calories, 70);
  } finally { globalThis.fetch = realFetch; }
});
