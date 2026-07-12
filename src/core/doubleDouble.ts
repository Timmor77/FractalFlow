// "Double-double" (DD) arithmetic.
//
// A DD number is represented by two float64s: hi + lo, where lo holds the error
// that hi cannot represent. This yields ~106 bits of mantissa, i.e. ~31 decimal
// digits (vs ~16 for a single float64).
//
// It is used for exactly two things:
//   - storing the view centre with enough precision for deep zoom;
//   - computing the perturbation reference orbit (see referenceOrbit.ts).
//
// So we only keep the operations we need: add, sub, mul, plus conversions.
// Nothing more.

// A double-double number: value = hi + lo, with |lo| <= 0.5 ulp(hi).
export type Dd = {
  hi: number;
  lo: number;
};

// Builds a DD from an ordinary float64 (lo = 0, no loss).
export function ddFromNumber(x: number): Dd {
  return { hi: x, lo: 0 };
}

// Converts a DD back to float64 (the extra precision is lost).
// Used for display and for computations that do not need DD precision.
export function ddToNumber(a: Dd): number {
  return a.hi + a.lo;
}

// Exact sum of two float64s: returns [s, e] such that a + b = s + e exactly,
// with s = fl(a + b). Knuth's "TwoSum" algorithm (no assumption on |a|,|b|).
function twoSum(a: number, b: number): [number, number] {
  const s = a + b;
  const bb = s - a;
  const e = (a - (s - bb)) + (b - bb);
  return [s, e];
}

// Fast exact sum when we already know that |a| >= |b|. "QuickTwoSum".
function quickTwoSum(a: number, b: number): [number, number] {
  const s = a + b;
  const e = b - (s - a);
  return [s, e];
}

// Exact product of two float64s: returns [p, e] such that a * b = p + e exactly.
// JavaScript has no FMA, so we use Dekker's "TwoProduct" with a split.
// 134217729 = 2^27 + 1, the split constant for a 53-bit mantissa.
function twoProd(a: number, b: number): [number, number] {
  const p = a * b;

  const ca = 134217729 * a;
  const ahi = ca - (ca - a);
  const alo = a - ahi;

  const cb = 134217729 * b;
  const bhi = cb - (cb - b);
  const blo = b - bhi;

  const e = ((ahi * bhi - p) + ahi * blo + alo * bhi) + alo * blo;
  return [p, e];
}

// DD + DD addition.
export function ddAdd(a: Dd, b: Dd): Dd {
  const [s, e0] = twoSum(a.hi, b.hi);
  const e = e0 + a.lo + b.lo;
  const [hi, lo] = quickTwoSum(s, e);
  return { hi, lo };
}

// DD + float64 addition (common case: shifting the centre by a small delta).
export function ddAddNumber(a: Dd, b: number): Dd {
  const [s, e0] = twoSum(a.hi, b);
  const e = e0 + a.lo;
  const [hi, lo] = quickTwoSum(s, e);
  return { hi, lo };
}

// DD - DD subtraction.
export function ddSub(a: Dd, b: Dd): Dd {
  return ddAdd(a, { hi: -b.hi, lo: -b.lo });
}

// DD * DD multiplication.
export function ddMul(a: Dd, b: Dd): Dd {
  const [p, e0] = twoProd(a.hi, b.hi);
  const e = e0 + (a.hi * b.lo + a.lo * b.hi);
  const [hi, lo] = quickTwoSum(p, e);
  return { hi, lo };
}
