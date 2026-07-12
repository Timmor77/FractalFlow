// Double-double arithmetic tests.
//
// The DD claims are strong ("~106 bits of mantissa, error-free transforms"),
// so they are checked against exact ground truths:
//   - powers of two, which float64 represents exactly;
//   - BigInt integer arithmetic, which is exact by construction.

import { describe, it, expect } from "vitest";
import {
  ddFromNumber,
  ddToNumber,
  ddAdd,
  ddAddNumber,
  ddSub,
  ddMul,
  type Dd,
} from "../src/core/doubleDouble";

describe("conversions", () => {
  it("round-trips plain float64 values without loss", () => {
    for (const x of [0, 1, -1, 3.14159, 1e-30, -2.5e17, Number.MIN_VALUE]) {
      expect(ddToNumber(ddFromNumber(x))).toBe(x);
    }
  });
});

describe("exact arithmetic with powers of two", () => {
  // 2^-60 is far below one ulp of 1, so a plain float64 sum would lose it
  // entirely. DD must keep it in the lo component, exactly.
  it("keeps a tiny addend that float64 would drop", () => {
    const tiny = 2 ** -60;
    const sum = ddAddNumber(ddFromNumber(1), tiny);
    expect(sum.hi).toBe(1);
    expect(sum.lo).toBe(tiny);
    expect(1 + tiny).toBe(1); // the float64 counterpart silently loses it
  });

  it("recovers the tiny part through subtraction", () => {
    const tiny = 2 ** -60;
    const sum = ddAddNumber(ddFromNumber(1), tiny);
    const back = ddSub(sum, ddFromNumber(1));
    expect(ddToNumber(back)).toBe(tiny);
  });

  // (1 + 2^-30)² = 1 + 2^-29 + 2^-60. Float64 keeps the 2^-29 term but drops
  // the 2^-60 one; DD must hold both.
  it("squares (1 + 2^-30) exactly", () => {
    const x = ddFromNumber(1 + 2 ** -30);
    const sq = ddMul(x, x);
    expect(sq.hi).toBe(1 + 2 ** -29);
    expect(sq.lo).toBe(2 ** -60);
  });
});

// Deterministic pseudo-random integers (no test flakiness).
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
}

// Exact value of a DD as a BigInt, valid when both components are integers.
function ddToBigInt(a: Dd): bigint {
  return BigInt(a.hi) + BigInt(a.lo);
}

describe("BigInt ground truth", () => {
  // Products of integers < 2^50 need up to 100 bits — beyond float64's 53-bit
  // mantissa but within DD's ~106 bits, so hi + lo must equal a*b EXACTLY.
  // This validates the TwoProd/Dekker-split machinery end to end.
  it("multiplies 50-bit integers exactly (hi + lo === a·b)", () => {
    const rng = makeRng(42);
    for (let k = 0; k < 100; k++) {
      const a = rng() * 2 ** 20 + rng(); // up to ~2^52, keep below 2^50 via mask
      const b = rng() * 2 ** 18 + rng();
      const ai = Math.floor(a % 2 ** 50);
      const bi = Math.floor(b % 2 ** 50);
      const prod = ddMul(ddFromNumber(ai), ddFromNumber(bi));
      expect(Number.isInteger(prod.hi)).toBe(true);
      expect(Number.isInteger(prod.lo)).toBe(true);
      expect(ddToBigInt(prod)).toBe(BigInt(ai) * BigInt(bi));
    }
  });

  // Sums of two ~2^80 DD values (built from exact power-of-two halves) must
  // also be exact. This validates TwoSum with values of very different scales.
  it("adds large mixed-scale values exactly", () => {
    const rng = makeRng(7);
    for (let k = 0; k < 100; k++) {
      const aHi = Math.floor(rng() % 2 ** 30) * 2 ** 50; // multiple of 2^50
      const aLo = Math.floor(rng() % 2 ** 30);
      const bHi = Math.floor(rng() % 2 ** 30) * 2 ** 50;
      const bLo = Math.floor(rng() % 2 ** 30);
      const a: Dd = { hi: aHi, lo: aLo };
      const b: Dd = { hi: bHi, lo: bLo };
      const sum = ddAdd(a, b);
      expect(ddToBigInt(sum)).toBe(
        BigInt(aHi) + BigInt(aLo) + BigInt(bHi) + BigInt(bLo),
      );
    }
  });
});

describe("algebraic identities", () => {
  it("x · 1 === x", () => {
    const x: Dd = { hi: 3.141592653589793, lo: 1.2246467991473532e-16 };
    const prod = ddMul(x, ddFromNumber(1));
    expect(prod.hi).toBe(x.hi);
    expect(prod.lo).toBe(x.lo);
  });

  it("a - b === -(b - a)", () => {
    const a: Dd = { hi: 0.1, lo: 5.551115123125783e-18 };
    const b: Dd = { hi: 0.3, lo: -1.6653345369377348e-17 };
    const d1 = ddSub(a, b);
    const d2 = ddSub(b, a);
    expect(d1.hi).toBe(-d2.hi);
    expect(d1.lo).toBe(-d2.lo);
  });
});
