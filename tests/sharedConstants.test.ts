// Cross-language drift guard.
//
// The same handful of numbers is written out by hand in four places: the WGSL
// shader, the GLSL fallback shader, the CUDA kernel and the Python reference
// renderer. That duplication is deliberate — the reference must not import the
// implementation it validates — but nothing stops one copy from being edited
// alone, and the symptom (a whole-image colour shift) only shows up in a slow
// mpmath comparison.
//
// These tests read the four source files and assert the constants still agree.

import { describe, it, expect } from "vitest";
import { PALETTES, DEFAULT_PALETTE } from "../src/ui/palettes";
import wgsl from "../src/backends/webgpu/julia.wgsl?raw";
import glsl from "../src/backends/webgl/julia.frag.glsl?raw";
import cuda from "../cuda/julia.cu?raw";
import python from "../scripts/reference_julia.py?raw";

const SOURCES = { wgsl, glsl, cuda, python };

describe("shared rendering constants", () => {
  it("uses the same escape radius squared everywhere", () => {
    expect(SOURCES.wgsl).toContain("> 4.0");
    expect(SOURCES.glsl).toContain("> 4.0");
    expect(SOURCES.cuda).toContain("> 4.0");
    expect(SOURCES.python).toContain("> 4");
  });

  it("uses the same log-damped colour density everywhere", () => {
    // t = 5.545 * log2(1 + smoothIter / 400)
    expect(SOURCES.wgsl).toContain("5.545 * log2(1.0 + smoothIter / 400.0)");
    expect(SOURCES.glsl).toContain("5.545 * log2(1.0 + smoothIter / 400.0)");
    expect(SOURCES.cuda).toContain("5.545f * log2f(1.0f + si / 400.0f)");
    expect(SOURCES.python).toContain("5.545 * math.log2(1.0 + si / 400.0)");
  });

  it("uses the same smooth iteration count everywhere", () => {
    // smoothIter = iter + 1 - log2(log2(|z|))
    expect(SOURCES.wgsl).toContain("log2(0.5 * log2(mag2))");
    expect(SOURCES.glsl).toContain("log2(0.5 * log2(mag2))");
    expect(SOURCES.cuda).toContain("log2f(0.5f * log2f((float)mag2))");
    expect(SOURCES.python).toContain("math.log2(0.5 * math.log2(mag2))");
  });

  it("keeps the CUDA palette stops in step with the browser default", () => {
    const stops = PALETTES[DEFAULT_PALETTE].stops;
    const positions = stops.map((stop) => stop.pos);
    expect(positions).toEqual([0, 0.16, 0.42, 0.6425, 0.8575, 1.0]);
    // The CUDA kernel and the Python reference hard-code the same table.
    expect(SOURCES.cuda).toContain("{0.0f, 0.16f, 0.42f, 0.6425f, 0.8575f, 1.0f}");
    expect(SOURCES.python).toContain("[0.0, 0.16, 0.42, 0.6425, 0.8575, 1.0]");
    for (const stop of stops) {
      const [r, g, b] = stop.color;
      expect(SOURCES.python).toContain(`(${r}, ${g}, ${b})`);
    }
  });

  it("tests escape before advancing, in every backend", () => {
    // An escape test placed after the update shifts every smooth iteration
    // count by one; the fallback shader shipped that way once.
    const bodies: [string, string, RegExp][] = [
      [SOURCES.wgsl, "loop {", /let ndx =/],
      [SOURCES.glsl, "for (int i = 0; i < 4096; i++)", /vec2 x2 = dsMul/],
      [SOURCES.cuda, "while (iter < maxIter)", /double ndx =/],
    ];
    for (const [source, loopStart, advance] of bodies) {
      const body = source.slice(source.indexOf(loopStart));
      expect(body.length).toBeGreaterThan(0);
      expect(body.indexOf("> 4.0")).toBeGreaterThan(0);
      expect(body.indexOf("> 4.0")).toBeLessThan(body.search(advance));
    }
  });
});
