// Sonnet 5.5 thinks before it answers. The first content block is often a
// thinking block whose text is empty, and max_tokens includes that thinking.
// These helpers read the real answer and keep the model from spending the
// whole budget on up-front thinking (no tools on these calls).

export const NO_UPFRONT_THINKING = {
  thinking: { type: 'between_tools' },
  output_config: { effort: 'medium' },
};

export function textFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => {
      if (!block || typeof block.text !== 'string') return false;
      if (block.type === 'thinking' || block.type === 'redacted_thinking') return false;
      return !block.type || block.type === 'text';
    })
    .map(block => block.text)
    .join('\n');
}

function jsonValueEnd(src, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Last complete JSON value. A draft object before the final one is skipped.
export function lastJsonValue(text) {
  const src = String(text ?? '');
  let last = null;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch !== '{' && ch !== '[') { i += 1; continue; }
    const end = jsonValueEnd(src, i);
    if (end < 0) { i += 1; continue; }
    try {
      last = JSON.parse(src.slice(i, end));
      i = end;
    } catch {
      i += 1;
    }
  }
  return last;
}
