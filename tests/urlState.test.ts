// Shareable-link tests: a view must survive the URL round trip exactly, and a
// malformed or partial hash must never turn into a plausible wrong view.

import { describe, it, expect } from "vitest";
import { serializeState, parseState } from "../src/core/urlState";

const PALETTE_COUNT = 6;

describe("round trip", () => {
  it("restores a deep-zoom view bit for bit, including the DD low words", () => {
    const state = {
      centerX: { hi: -0.5275031186435346, lo: 1.9e-17 },
      centerY: { hi: 0.07591217835228788, lo: -3.2e-18 },
      scale: 1e-20,
      cx: -0.8,
      cy: 0.156,
      palette: 4,
    };
    const parsed = parseState(serializeState(state), PALETTE_COUNT);
    expect(parsed).toEqual({
      centerX: state.centerX,
      centerY: state.centerY,
      scale: state.scale,
      c: { x: state.cx, y: state.cy },
      palette: state.palette,
    });
  });

  it("reads the gallery links of the README", () => {
    const parsed = parseState("x=0_0&y=0_0&s=3&cx=-0.7269&cy=0.1889&p=2", PALETTE_COUNT);
    expect(parsed?.scale).toBe(3);
    expect(parsed?.c).toEqual({ x: -0.7269, y: 0.1889 });
    expect(parsed?.palette).toBe(2);
  });
});

describe("rejected hashes", () => {
  it.each([
    ["empty", ""],
    ["no camera", "cx=-0.8&cy=0.156"],
    ["centre without its low word", "x=0&y=0_0&s=3"],
    ["empty centre parts", "x=_&y=0_0&s=3"],
    ["non-numeric centre", "x=a_b&y=0_0&s=3"],
    ["missing scale", "x=0_0&y=0_0"],
    ["zero scale", "x=0_0&y=0_0&s=0"],
    ["negative scale", "x=0_0&y=0_0&s=-1"],
    ["infinite scale", "x=0_0&y=0_0&s=Infinity"],
  ])("returns null for %s", (_label, hash) => {
    expect(parseState(hash, PALETTE_COUNT)).toBeNull();
  });
});

describe("optional fields", () => {
  // Number(null) is 0: a link without c used to load c = 0 (a plain circle)
  // and reset the palette, instead of keeping the current ones.
  it("leaves c and the palette untouched when the link omits them", () => {
    const parsed = parseState("x=0_0&y=0_0&s=3", PALETTE_COUNT);
    expect(parsed).not.toBeNull();
    expect(parsed?.c).toBeNull();
    expect(parsed?.palette).toBeNull();
  });

  it("ignores half a c", () => {
    expect(parseState("x=0_0&y=0_0&s=3&cx=0.285", PALETTE_COUNT)?.c).toBeNull();
  });

  it("ignores a palette index out of range", () => {
    expect(parseState("x=0_0&y=0_0&s=3&p=6", PALETTE_COUNT)?.palette).toBeNull();
    expect(parseState("x=0_0&y=0_0&s=3&p=-1", PALETTE_COUNT)?.palette).toBeNull();
    expect(parseState("x=0_0&y=0_0&s=3&p=5", PALETTE_COUNT)?.palette).toBe(5);
  });
});
