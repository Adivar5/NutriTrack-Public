// [feat:photos] Validation of chat messages that may carry a vision image block.
const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp'];
// base64 chars; ~1MB of base64 text (decoded ~750KB) — client sends ~150KB.
const MAX_BASE64_CHARS = 1024 * 1024;
// Per-request caps so one call cannot run up the Anthropic bill. A chat resets
// daily, so these are far above normal use.
const MAX_MESSAGES = 100;
const MAX_TEXT_CHARS = 100_000;
const MAX_IMAGES = 1;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function validateBlock(block) {
  if (!block || typeof block !== 'object') return 'Invalid content block';
  if (block.type === 'text') {
    return typeof block.text === 'string' ? null : 'Text block must have string text';
  }
  if (block.type === 'image') {
    const s = block.source;
    if (!s || s.type !== 'base64') return 'Image source must be base64';
    if (!ALLOWED_MEDIA.includes(s.media_type)) return 'Unsupported image type';
    if (typeof s.data !== 'string' || !s.data) return 'Image data missing';
    if (s.data.length > MAX_BASE64_CHARS) return 'Image too large';
    if (!BASE64_RE.test(s.data)) return 'Image data is not valid base64';
    return null;
  }
  return 'Only text and image blocks are allowed';
}

/** @returns {string|null} error message, or null when valid */
export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'messages must be a non-empty array';
  if (messages.length > MAX_MESSAGES) return `Too many messages (max ${MAX_MESSAGES})`;
  let images = 0;
  let textChars = 0;
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'Invalid message role';
    if (typeof m.content === 'string') {
      textChars += m.content.length;
      continue;
    }
    if (!Array.isArray(m.content) || m.content.length === 0) return 'Invalid message content';
    for (const b of m.content) {
      const err = validateBlock(b);
      if (err) return err;
      if (b.type === 'image') images += 1;
      else textChars += b.text.length;
    }
  }
  if (images > MAX_IMAGES) return `Max ${MAX_IMAGES} image per request`;
  if (textChars > MAX_TEXT_CHARS) return 'Messages too long';
  return null;
}

/** Flatten array content to text only, so lib/rag.js (string-only) keeps working. */
export function textOnlyMessages(messages) {
  return messages.map((m) => {
    if (typeof m.content === 'string') return m;
    const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return { ...m, content: text };
  });
}

export const __limits = { MAX_BASE64_CHARS, ALLOWED_MEDIA, MAX_MESSAGES, MAX_TEXT_CHARS, MAX_IMAGES };
// [/feat:photos]
