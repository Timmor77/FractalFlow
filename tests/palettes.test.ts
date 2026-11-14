// Palette lookup table.
//
// The browser samples a 256-texel table; the CUDA kernel and the Python
// reference evaluate the gradient analytically. The two only agree if each
// texel holds the colour of its CENTRE, which is where the GPU reads it.

import { describe, it, expect } from "vitest";
import { PALETTES, DEFAULT_PALETTE, buildPaletteLut } from "../src/ui/palettes";
import type { Stop } from "../src/ui/palettes";

// The gradient as julia.cu and reference_julia.py evaluate it.
function analytic(stops: Stop[], t: number): number[] {
  const u = t - Math.floor(t);
  for (let k = 0; k < stops.length - 1; k++) {
    if (u <= stops[k + 1].pos) {
      const f = (u - stops[k].pos) / (stops[k + 1].pos - stops[k].pos);
      return [0, 1, 2].map(
        (j) => stops[k].color[j] + (stops[k + 1].color[j] - stops[k].color[j]) * f,
      );
    }
  }
  return stops[stops.length - 1].color;
}

// What the shaders get: linear filtering, repeat wrap, texel centres at
// (i + 0.5) / size.
function sample(lut: Uint8Array, t: number): number[] {
  const size = lut.length / 4;
  const u = t * size - 0.5;
  const i0 = Math.floor(u);
  const f = u - i0;
  const a = ((i0 % size) + size) % size;
  const b = (a + 1) % size;
  return [0, 1, 2].map((j) => lut[a * 4 + j] * (1 - f) + lut[b * 4 + j] * f);
}

describe("palette LUT", () => {
  it("is 256 opaque RGBA texels", () => {
    const lut = buildPaletteLut(PALETTES[DEFAULT_PALETTE]);
    expect(lut.length).toBe(256 * 4);
    for (let i = 3; i < lut.length; i += 4) {
      expect(lut[i]).toBe(255);
    }
  });

  it.each(PALETTES.map((palette) => [palette.name, palette] as const))(
    "%s: GPU sampling tracks the analytic gradient",
    (_name, palette) => {
      const lut = buildPaletteLut(palette);
      const samples = 20000;
      let sum = 0;
      for (let s = 0; s < samples; s++) {
        const t = (s + 0.37) / samples;
        const expected = analytic(palette.stops, t);
        const got = sample(lut, t);
        for (let j = 0; j < 3; j++) {
          sum += Math.abs(expected[j] - got[j]);
        }
      }
      // Half a texel of misalignment costs about one level on the default
      // palette; aligned, only 8-bit rounding and the corners at the stops
      // remain.
      expect(sum / (samples * 3)).toBeLessThan(0.3);
    },
  );
});
