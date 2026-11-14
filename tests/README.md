# Tests

Unit tests for everything that runs without a GPU, with
[Vitest](https://vitest.dev/) (`npm test`):

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

- **`pngEncoder.test.ts`** — the streaming PNG encoder, checked by a decoder
  written here from the specification and sharing no code with it: chunk CRCs
  recomputed bit by bit, the zlib stream inflated by the platform, every row
  un-filtered. Bands of uneven height, buffer reuse, filter choice, misuse.
- **`export.test.ts`** — the tile layout covers every pixel exactly once at
  every size up to 16K, and `exportPng` puts each tile at its place: a fake
  renderer encodes pixel coordinates in the colours, so a misplaced, flipped
  or truncated tile shows up in the decoded image. Progress and cancellation.
- **`frameLoop.test.ts`** — the render loop on a fake clock: reduced
  resolution in motion, exactly one sharp frame at rest, nothing while paused.
- **`urlState.test.ts`** — shared links: a deep-zoom view survives the URL
  round trip bit for bit, and malformed or partial hashes are rejected instead
  of becoming a plausible wrong view.
- **`palettes.test.ts`** — the 256-texel palette table, sampled the way the GPU
  samples it, tracks the analytic gradient used by CUDA and Python.
- **`resolutionGovernor.test.ts`** — the interaction resolution drops when
  frames are late and recovers on a 60 Hz display as well as a fast one.
- **`sharedConstants.test.ts`** — the constants written by hand in WGSL, GLSL,
  CUDA and Python still agree.

GPU output itself is validated separately against the `mpmath`
arbitrary-precision reference: CUDA by `scripts/validate_release.py`, WebGPU by
the `/?validate` page — see the *Correctness* section of the top-level README.

Generated images and measurements belong in `artifacts/`, not in this folder.
