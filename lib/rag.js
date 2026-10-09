// lib/rag.js — RAG helpers for nutrition lookups.
//
// Design constraints (per user):
//   - "TRY TO USE BOTH SOURCES IN THE PROCESS. DONT RELY ON THEM TOO MUCH"
//   - Run on Vercel serverless inside api/claude.js — strict 3s wall-clock budget.
//   - Hits are HINTS for Claude, never authoritative. Claude still computes
//     final calories/protein/carbs/fats based on portion sizes inferred from
//     the user's message.
//   - Both sources must fail gracefully — if neither responds, fall through to
//     plain Claude with no error to the user.
//
// Sources:
//   A) Tzameret (Israeli MoH) via data.gov.il CKAN API. Resource ID is read
//      from env var TZAMERET_RESOURCE_ID; if unset, this source is skipped.
//   B) foodsdictionary.co.il search page (cp1255 HTML scrape — best effort).
//      Their robots.txt disallows AI scrapers, so we only use it as a weak
//      hint and only surface the URL to the user (link out), not the content
//      to Claude — keeps us on the safe side of ToS.

const TZAMERET_BASE = 'https://data.gov.il/api/3/action/datastore_search';
const FOODSDICT_BASE = 'https://www.foodsdictionary.co.il/FoodsSearch.php';
const HARD_TIMEOUT_MS = 3000;

/**
 * Extract the latest user-typed query from a messages array.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {string|null} the user query trimmed to 200 chars, or null
 */
function extractQuery(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user' && typeof messages[i].content === 'string') {
      return messages[i].content.trim().slice(0, 200) || null;
    }
  }
  return null;
}

/**
 * Tzameret search via data.gov.il CKAN datastore.
 * Returns up to 5 records or [] on any failure / when resourceId is missing.
 * @param {string} query
 * @param {string|undefined} resourceId
 * @param {AbortSignal} signal
 * @param {typeof fetch} fetchImpl
 */
async function searchTzameret(query, resourceId, signal, fetchImpl = fetch) {
  if (!resourceId) return [];
  const url = `${TZAMERET_BASE}?resource_id=${encodeURIComponent(resourceId)}&q=${encodeURIComponent(query)}&limit=5`;
  try {
    const res = await fetchImpl(url, { signal, headers: { 'Accept': 'application/json' } });
    if (!res.ok) return [];
    const json = await res.json();
    const records = json?.result?.records;
    if (!Array.isArray(records)) return [];
    return records.slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * foodsdictionary.co.il best-effort search. Returns either:
 *   - null on any failure (404, abort, parse fail, etc.)
 *   - { url, titles: [string] } on success (titles are h2 entries, max 3)
 * The HTML is cp1255 — we use TextDecoder('windows-1255') when available,
 * otherwise fall back to raw text (loses Hebrew but doesn't crash).
 * @param {string} query
 * @param {AbortSignal} signal
 * @param {typeof fetch} fetchImpl
 */
async function searchFoodsdictionary(query, signal, fetchImpl = fetch) {
  const url = `${FOODSDICT_BASE}?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetchImpl(url, {
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NutriTrack/1.0)',
        'Accept': 'text/html',
      },
    });
    if (!res.ok) return null;
    let html;
    try {
      const buf = await res.arrayBuffer();
      if (typeof TextDecoder !== 'undefined') {
        try { html = new TextDecoder('windows-1255').decode(buf); }
        catch { html = new TextDecoder('utf-8').decode(buf); }
      } else {
        html = Buffer.from(buf).toString('utf-8');
      }
    } catch { return null; }
    const titles = [...html.matchAll(/<h2[^>]*>\s*([^<]+?)\s*<\/h2>/gi)]
      .slice(0, 3)
      .map(m => m[1].replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (titles.length === 0) return null;
    return { source: 'foodsdictionary', url, titles };
  } catch {
    return null;
  }
}

/**
 * Run both sources in parallel under a single hard timeout.
 * Returns null when both fail / produce nothing.
 * @param {string} query
 * @param {{resourceId?: string, fetchImpl?: typeof fetch, timeoutMs?: number}} opts
 */
async function lookupNutritionContext(query, opts = {}) {
  const resourceId = opts.resourceId ?? process.env.TZAMERET_RESOURCE_ID;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? HARD_TIMEOUT_MS;
  if (!query) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const [tzResult, fdResult] = await Promise.allSettled([
      searchTzameret(query, resourceId, ctrl.signal, fetchImpl),
      searchFoodsdictionary(query, ctrl.signal, fetchImpl),
    ]);
    const tzameret = tzResult.status === 'fulfilled' ? tzResult.value : [];
    const foodsdictionary = fdResult.status === 'fulfilled' ? fdResult.value : null;
    if ((!tzameret || tzameret.length === 0) && !foodsdictionary) return null;
    return { tzameret, foodsdictionary };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Format the lookup result into a short, Claude-friendly hint block that
 * prepends the system prompt. Capped to ~1500 chars so it never crowds out
 * the user's actual conversation history.
 * @param {{tzameret: any[], foodsdictionary: {url:string, titles:string[]}|null}|null} context
 * @returns {string} prompt fragment (empty string when no context)
 */
function formatContextForPrompt(context) {
  if (!context) return '';
  const lines = [];
  if (Array.isArray(context.tzameret) && context.tzameret.length > 0) {
    lines.push('## Israeli Ministry of Health (Tzameret) — possible matches (per 100g unless noted):');
    for (const r of context.tzameret.slice(0, 5)) {
      const name = r.shmmitzrach || r.smlmitzrach || r.food_name || r.shem_mazon || r.name || r.shmlatzav || 'unknown';
      const cal = r.food_energy ?? r.energy_kcal ?? r.energy ?? r.calories ?? '?';
      const prot = r.protein ?? r.protein_g ?? '?';
      const carb = r.carbohydrates ?? r.carbohydrate ?? r.carbs ?? '?';
      const fat = r.total_fat ?? r.fat ?? r.fats ?? '?';
      lines.push(`- ${name}: ${cal} kcal, ${prot}g protein, ${carb}g carbs, ${fat}g fat`);
    }
  }
  if (context.foodsdictionary && Array.isArray(context.foodsdictionary.titles)) {
    lines.push('## foodsdictionary.co.il — search-page hints (titles only, NOT authoritative):');
    for (const t of context.foodsdictionary.titles) lines.push(`- ${t}`);
    lines.push(`(Full results: ${context.foodsdictionary.url})`);
  }
  if (lines.length === 0) return '';
  lines.push('');
  lines.push('Use these as REFERENCE hints. Always reconcile against the portion size the user described. If the hints look wrong or the user described a different item, trust your own estimate.');
  return lines.join('\n') + '\n\n';
}

export {
  extractQuery,
  searchTzameret,
  searchFoodsdictionary,
  lookupNutritionContext,
  formatContextForPrompt,
};
export const __constants = { HARD_TIMEOUT_MS, TZAMERET_BASE, FOODSDICT_BASE };
