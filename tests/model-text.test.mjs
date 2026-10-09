import test from 'node:test';
import assert from 'node:assert/strict';
import { textFromContent, lastJsonValue } from '../lib/model-text.js';

test('textFromContent skips a leading empty thinking block', () => {
  const text = textFromContent([
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: '{"items":[]}' },
  ]);
  assert.equal(text, '{"items":[]}');
});

test('textFromContent keeps legacy blocks that have text and no type', () => {
  assert.equal(textFromContent([{ text: 'hello' }]), 'hello');
});

test('lastJsonValue keeps the final object, not an earlier draft', () => {
  const text = 'Draft {"items":[{"name":"wrong"}]} then {"items":[{"name":"egg","calories":70}],"message":"ok"}';
  const parsed = lastJsonValue(text);
  assert.equal(parsed.items[0].name, 'egg');
  assert.equal(parsed.message, 'ok');
});

test('lastJsonValue ignores braces inside strings', () => {
  const parsed = lastJsonValue('{"message":"use {braces}","items":[]}');
  assert.equal(parsed.message, 'use {braces}');
  assert.deepEqual(parsed.items, []);
});
