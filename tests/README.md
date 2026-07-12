# Tests

Unit tests for the CPU-side math core, run with [Vitest](https://vitest.dev/)
(`npm test`):

- **`doubleDouble.test.ts`** — the double-double arithmetic is checked against
  exact ground truths: powers of two (representable exactly in float64) and
  BigInt integer arithmetic (products of 50-bit integers must satisfy
  `hi + lo === a·b` exactly).
- **`viewport.test.ts`** — camera invariants, chiefly *zoom-at-cursor*: the
  complex-plane point under the cursor stays fixed through a full animated
  zoom. Plus scale clamping, exact panning, state round-trips and reset.
- **`referenceOrbit.test.ts`** — the perturbation reference orbit matches a
  direct float64 iteration within float32 rounding, and respects its length
  and buffer-size invariants (the GPU upload contract).

GPU output itself is validated separately, pixel-for-pixel, against the
`mpmath` arbitrary-precision reference — see `scripts/reference_julia.py` and
the *Correctness* section of the top-level README.

Generated images and measurements belong in `artifacts/`, not in this folder.
