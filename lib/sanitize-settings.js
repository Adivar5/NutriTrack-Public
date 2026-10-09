// Client `settings` are interpolated into the system prompt, so only finite numbers
// may get through. Unlike api/recap.js (which rejects), chat must keep working for
// a brand-new profile (startWeight null), so bad values are clamped / defaulted.
const SPEC = {
  tdee: [500, 10000, 2000],
  calMin: [0, 10000, 1500],
  calMax: [0, 10000, 2000],
  protMin: [0, 1000, 100],
  protMax: [0, 1000, 150],
};

const clamp = (v, lo, hi, dflt) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;

/** @returns {{tdee:number,calMin:number,calMax:number,protMin:number,protMax:number,startWeight:number|null}} */
export function sanitizeSettings(s) {
  const src = s !== null && typeof s === 'object' ? s : {};
  const out = Object.fromEntries(
    Object.entries(SPEC).map(([k, [lo, hi, dflt]]) => [k, clamp(src[k], lo, hi, dflt)]),
  );
  out.startWeight = clamp(src.startWeight, 20, 400, null);
  return out;
}
