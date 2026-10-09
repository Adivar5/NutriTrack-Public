// [insights:helpers]
// Pure, client-side derived-display helpers (no I/O, no mutation).
const PROTEIN_SUGGESTIONS = [
  { grams: 15, text: "a Greek yogurt (~15g)" },
  { grams: 25, text: "a tuna can (~25g)" },
  { grams: 45, text: "150g chicken breast (~45g)" },
];
const PROTEIN_FALLBACK = "two 150g chicken breasts (~90g)";

export function proteinNudge(goals, totalProt, hour) {
  const min = goals && Number(goals.protMin);
  const have = Number(totalProt) || 0;
  if (!min || !(min > 0) || have >= min) return null;
  const remaining = Math.ceil(min - have);
  const pick = PROTEIN_SUGGESTIONS.find((s) => s.grams >= remaining);
  const prefix = hour >= 17 ? "Evening check: " : "";
  return `${prefix}${remaining}g protein to go — ${pick ? pick.text : PROTEIN_FALLBACK}`;
}

export function movingAverage(values, window) {
  const list = Array.isArray(values) ? values : [];
  const half = Math.floor((window > 0 ? window : 1) / 2);
  return list.map((_, i) => {
    const slice = list.slice(Math.max(0, i - half), i + half + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

export function parseDMY(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(str || "").trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  const ok = back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d;
  return ok ? t : null;
}

export function weeklyRate(entries) {
  const DAY = 86400000;
  const pts = (Array.isArray(entries) ? entries : [])
    .map((e) => ({ t: parseDMY(e && e.date), w: Number(e && e.weight) }))
    .filter((p) => p.t !== null && Number.isFinite(p.w) && p.w > 0)
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) return null;
  const cutoff = pts[pts.length - 1].t - 28 * DAY;
  const win = pts.filter((p) => p.t >= cutoff);
  if (win.length < 3 || win[win.length - 1].t - win[0].t < 7 * DAY) return null;
  const xs = win.map((p) => (p.t - win[0].t) / DAY);
  const n = win.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = win.reduce((s, p) => s + p.w, 0) / n;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (win[i].w - my), 0);
  const den = xs.reduce((s, x) => s + (x - mx) * (x - mx), 0);
  return den === 0 ? null : (num / den) * 7;
}
// [/insights:helpers]
