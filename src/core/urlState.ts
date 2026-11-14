// Shareable view state, carried in the URL hash (#x=…&y=…&s=…&cx=…&cy=…&p=…).
//
// The centre is written as double-double "hi_lo" pairs so a deep-zoom link
// stays exact; scale, c and the palette index are plain numbers. Pure functions,
// no DOM: main.ts reads and writes location.hash around them.

import type { Dd } from "./doubleDouble";

export type SharedState = {
  centerX: Dd;
  centerY: Dd;
  scale: number;
  cx: number;
  cy: number;
  palette: number;
};

// What a hash yields. The camera part is mandatory; c and the palette are
// optional (null = "not in the link, keep the current one").
export type ParsedState = {
  centerX: Dd;
  centerY: Dd;
  scale: number;
  c: { x: number; y: number } | null;
  palette: number | null;
};

export function serializeState(state: SharedState): string {
  const params = new URLSearchParams();
  params.set("x", `${state.centerX.hi}_${state.centerX.lo}`);
  params.set("y", `${state.centerY.hi}_${state.centerY.lo}`);
  params.set("s", String(state.scale));
  params.set("cx", String(state.cx));
  params.set("cy", String(state.cy));
  params.set("p", String(state.palette));
  return params.toString();
}

// Number("") and Number(null) are both 0: a missing or empty field must not
// silently become a valid zero.
function parseNumber(text: string | null): number {
  if (text === null || text.trim() === "") {
    return Number.NaN;
  }
  return Number(text);
}

function parseDd(text: string | null): Dd | null {
  const parts = (text ?? "").split("_");
  if (parts.length !== 2) {
    return null;
  }
  const hi = parseNumber(parts[0]);
  const lo = parseNumber(parts[1]);
  return Number.isFinite(hi) && Number.isFinite(lo) ? { hi, lo } : null;
}

// Parses a hash (without the leading "#"). Returns null when the camera part
// is missing or malformed: the caller then keeps its current view.
export function parseState(raw: string, paletteCount: number): ParsedState | null {
  if (!raw) {
    return null;
  }
  const params = new URLSearchParams(raw);
  const centerX = parseDd(params.get("x"));
  const centerY = parseDd(params.get("y"));
  const scale = parseNumber(params.get("s"));
  if (centerX === null || centerY === null || !Number.isFinite(scale) || scale <= 0) {
    return null;
  }

  const cx = parseNumber(params.get("cx"));
  const cy = parseNumber(params.get("cy"));
  const c = Number.isFinite(cx) && Number.isFinite(cy) ? { x: cx, y: cy } : null;

  const p = parseNumber(params.get("p"));
  const palette = Number.isFinite(p) && p >= 0 && p < paletteCount ? Math.floor(p) : null;

  return { centerX, centerY, scale, c, palette };
}
