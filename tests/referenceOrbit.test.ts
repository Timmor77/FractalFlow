// Reference orbit tests.
//
// The orbit is compared against a plain float64 JS iteration: at shallow depth
// (centre of order 1) the DD computation must agree with float64 to within the
// float32 rounding of the stored array.

import { describe, it, expect } from "vitest";
import { computeReferenceOrbit } from "../src/core/referenceOrbit";
import { ddFromNumber } from "../src/core/doubleDouble";

const C = { x: -0.8, y: 0.156 }; // default Julia parameter (bounded orbit at 0)

describe("agreement with direct float64 iteration", () => {
  it("matches a float64 orbit within float32 rounding", () => {
    const maxIter = 200;
    const orbit = computeReferenceOrbit(
      ddFromNumber(0),
      ddFromNumber(0),
      C.x,
      C.y,
      maxIter,
    );

    let zx = 0;
    let zy = 0;
    for (let i = 0; i < orbit.length; i++) {
      // The stored value is the float32 rounding of the (higher-precision) orbit.
      // Float64 drift stays orders of magnitude below one f32 ulp here, so the
      // float32-rounded float64 value must match bit-for-bit.
      expect(orbit.data[i * 2]).toBe(Math.fround(zx));
      expect(orbit.data[i * 2 + 1]).toBe(Math.fround(zy));
      const nx = zx * zx - zy * zy + C.x;
      const ny = 2 * zx * zy + C.y;
      zx = nx;
      zy = ny;
    }
  });
});

describe("orbit length invariants", () => {
  it("runs to maxIter for a bounded orbit", () => {
    // c = -0.5: the orbit of 0 converges to an attracting fixed point, so it
    // is provably bounded. (The default c = -0.8 + 0.156i sits near the
    // boundary and its centre orbit actually escapes after ~253 iterations.)
    const orbit = computeReferenceOrbit(ddFromNumber(0), ddFromNumber(0), -0.5, 0, 500);
    expect(orbit.length).toBe(500);
    // Every stored point of a bounded orbit stays within the escape radius.
    for (let i = 0; i < orbit.length; i++) {
      const x = orbit.data[i * 2];
      const y = orbit.data[i * 2 + 1];
      expect(x * x + y * y).toBeLessThanOrEqual(4.0);
    }
  });

  it("keeps at least 2 points even when the centre escapes immediately", () => {
    // (2, 2) escapes at once, but the shader's rebasing reads Z[m+1], so the
    // orbit must contain the successor of the last reference point.
    const orbit = computeReferenceOrbit(ddFromNumber(2), ddFromNumber(2), C.x, C.y, 100);
    expect(orbit.length).toBeGreaterThanOrEqual(2);
    expect(orbit.length).toBeLessThanOrEqual(100);
  });

  it("always allocates maxIter * 2 floats (GPU upload contract)", () => {
    for (const maxIter of [1, 7, 300]) {
      const orbit = computeReferenceOrbit(ddFromNumber(3), ddFromNumber(0), C.x, C.y, maxIter);
      expect(orbit.data.length).toBe(maxIter * 2);
      expect(orbit.length).toBeLessThanOrEqual(maxIter);
    }
  });
});
