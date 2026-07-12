// Reference orbit for perturbation theory.
//
// Deep-zoom idea: instead of iterating z = z² + c for every pixel at huge
// precision (expensive), we iterate the view-centre orbit ONCE in high
// precision (double-double, ~31 digits); each pixel then only tracks a small
// "delta" offset from that reference, in float32 on the GPU.
//
// For Julia, c is constant, so the reference orbit is simply:
//   Z_0 = view centre
//   Z_{n+1} = Z_n² + c
//
// Each Z_n is stored as float32 (real part then imaginary part): that is what
// the shader reads. The high precision is only needed to POSITION the reference
// correctly; the Z_n values themselves stay of order 1 (the orbit is bounded).

import type { Dd } from "./doubleDouble";
import { ddSub, ddMul, ddAddNumber } from "./doubleDouble";

export type ReferenceOrbit = {
  // Interleaved points: [Zx0, Zy0, Zx1, Zy1, ...], ready to upload to the GPU.
  data: Float32Array;

  // Number of points actually computed (may be < maxIter if the orbit escapes).
  length: number;
};

// Squared escape radius. |Z| > 2 => the orbit diverges.
const ESCAPE_R2 = 4.0;

// Computes the reference orbit of the view centre, in double-double.
export function computeReferenceOrbit(
  centerX: Dd,
  centerY: Dd,
  cx: number,
  cy: number,
  maxIter: number,
): ReferenceOrbit {
  const data = new Float32Array(maxIter * 2);

  // Z starts at the view centre.
  let zx = centerX;
  let zy = centerY;

  let length = 0;

  for (let i = 0; i < maxIter; i++) {
    // Store the current point as float32 (the assignment rounds float64 -> float32).
    data[i * 2] = zx.hi + zx.lo;
    data[i * 2 + 1] = zy.hi + zy.lo;
    length = i + 1;

    // Escape test: beyond this the reference is meaningless. We always keep at
    // least 2 points (even if Z0 escapes immediately): the shader's rebasing
    // reads Z[m+1] after each delta advance, so it needs the successor of the
    // last point used as reference.
    const zxF = zx.hi + zx.lo;
    const zyF = zy.hi + zy.lo;
    if (i > 0 && zxF * zxF + zyF * zyF > ESCAPE_R2) {
      break;
    }

    // Z_{n+1} = Z_n² + c   (complex arithmetic in double-double)
    //   real      = Zx² - Zy² + cx
    //   imaginary = 2·Zx·Zy + cy
    const zx2 = ddMul(zx, zx);
    const zy2 = ddMul(zy, zy);
    const xy = ddMul(zx, zy);

    // Multiplying a DD by 2 is exact (2 is a power of two).
    const twoXy = { hi: 2 * xy.hi, lo: 2 * xy.lo };

    const nextX = ddAddNumber(ddSub(zx2, zy2), cx); // Zx² - Zy² + cx
    const nextY = ddAddNumber(twoXy, cy); // 2·Zx·Zy + cy

    zx = nextX;
    zy = nextY;
  }

  return { data, length };
}
