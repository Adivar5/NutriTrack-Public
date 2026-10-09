import { validateMessages, textOnlyMessages } from '../lib/validate-messages.js'; // [feat:photos]
import { extractQuery, lookupNutritionContext, formatContextForPrompt } from '../lib/rag.js';
import { textFromContent, lastJsonValue, NO_UPFRONT_THINKING } from '../lib/model-text.js';
import { authenticate } from '../lib/auth.js';
import { sanitizeSettings } from '../lib/sanitize-settings.js';

export default async function handler(req, res) {
  // Same-origin app: no CORS headers are sent, so other sites cannot call this from a browser.
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1+2. Validate Supabase JWT, then the ALLOWED_EMAILS allowlist (fails closed)
  const user = await authenticate(req, res);
  if (!user) return undefined;

  // 3. Parse request body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { messages, settings } = body || {};
  if (!messages || !settings) {
    return res.status(400).json({ error: 'Missing messages or settings' });
  }
  // [feat:photos]
  const msgError = validateMessages(messages);
  if (msgError) return res.status(400).json({ error: msgError });
  // [/feat:photos]

  // 4. RAG lookup (T3) — best-effort, never blocks > HARD_TIMEOUT_MS.
  // Failures are silent: app must keep working when sources are unreachable.
  let ragContext = null;
  let ragPrefix = '';
  try {
    const query = extractQuery(textOnlyMessages(messages)) /* [feat:photos] text only */;
    if (query) {
      ragContext = await lookupNutritionContext(query);
      ragPrefix = formatContextForPrompt(ragContext);
    }
  } catch (e) {
    console.warn('RAG lookup failed (continuing without it):', e.message);
  }

  // 5. Build system prompt (server-side — keeps prompt logic out of the browser)
  function buildSystem(cfg) {
    return `${ragPrefix}You are a personal nutrition assistant. The user tracks calories and protein for weight loss. You MUST respond ONLY with valid JSON — no explanation, no markdown, no extra text before or after.

User profile: TDEE ${cfg.tdee} kcal/day, calorie goal ${cfg.calMin}–${cfg.calMax} kcal, protein goal ${cfg.protMin}–${cfg.protMax}g, current weight ${cfg.startWeight ? `~${cfg.startWeight}kg` : 'unknown'}.

When the user describes food or exercise, calculate and respond ONLY with this exact JSON structure:
{"items":[{"name":"food name","calories":100,"protein":10,"carbs":12,"fats":3}],"total_calories":100,"total_protein":10,"message":"short English reply about what was logged","activity_calories":0}

Rules:
- items: array of ONLY the NEW foods from THIS message — never re-include foods already logged in previous messages
- Each item MUST include calories and protein (grams). Each item SHOULD also include carbs (grams) and fats (grams) when reasonably estimable. If a macro is genuinely unknowable for a specific item (e.g. pure water, plain coffee), omit that field rather than guess wildly — null/0 are both acceptable.
- activity_calories: kcal burned from EXTRA exercise beyond baseline (use 0 if none)
- message: 1 sentence acknowledging what was logged
- Never add text outside the JSON
- Never use markdown code blocks
- Estimate conservatively when uncertain (especially for portion sizes)
- If a photo is provided, identify the food in it and estimate portions, calories, protein, carbs and fats conservatively, using any accompanying user text as extra context`;
  }

  // 6. Call Anthropic API
  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 1024,
        ...NO_UPFRONT_THINKING,
        system: buildSystem(sanitizeSettings(settings)),
        messages,
      }),
    });
  } catch (err) {
    console.error('claude upstream fetch failed:', err.message);
    return res.status(502).json({ error: 'Upstream fetch failed' });
  }

  if (!anthropicRes.ok) {
    const errBody = await anthropicRes.json().catch(() => ({}));
    console.error('Anthropic error:', JSON.stringify(errBody));
    return res.status(502).json({ error: errBody.error?.message || 'Anthropic API error' });
  }

  const data = await anthropicRes.json();
  // Sonnet 5.5 may lead with an empty thinking block, or write a draft before
  // the final JSON. Hand the client one text block that is the meal object.
  const meal = lastJsonValue(textFromContent(data.content));
  if (!meal || typeof meal !== 'object' || Array.isArray(meal)) {
    console.error('Unparseable meal response', data.stop_reason);
    return res.status(502).json({ error: 'Could not parse meal response' });
  }
  data.content = [{ type: 'text', text: JSON.stringify(meal) }];
  // Attach a small RAG breadcrumb so the client can surface a "data from
  // Israeli MoH" badge. Sibling field the client reads; `content` above is
  // only the parsed meal JSON.
  if (ragContext) {
    data._rag = {
      tzameret_hits: Array.isArray(ragContext.tzameret) ? ragContext.tzameret.length : 0,
      foodsdictionary_url: ragContext.foodsdictionary?.url || null,
    };
  }
  return res.status(200).json(data);
}
