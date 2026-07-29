# FractalFlow

[![CI](https://github.com/Timmor77/FractalFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Timmor77/FractalFlow/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![WebGPU](https://img.shields.io/badge/WebGPU-WGSL-orange)
![CUDA](https://img.shields.io/badge/CUDA-C%2B%2B-76b900)
[![Technical report](https://img.shields.io/badge/Technical_report-PDF-b31b1b.svg)](paper/main.pdf)

Interactive, deep-zoom **Julia set explorer**. One algorithm — *perturbation theory* —
implemented twice, in **WGSL** (WebGPU) and **CUDA C**, with a direct double-single
**GLSL** renderer as a shallow compatibility fallback. The CUDA output is checked
pixel-for-pixel against an independent arbitrary-precision reference.

**[▶ Live demo](https://timmor77.github.io/FractalFlow/)** — WebGPU in Chrome/Edge,
automatic WebGL2 fallback elsewhere.

<p align="center">
  <!-- Native width (matches make_zoom_gif.py --width): browser upscaling would blur it. -->
  <img src="docs/zoom.gif" width="640"
       alt="Continuous deep zoom into the Julia set (×10⁹, rendered by the CUDA backend)">
</p>

## Highlights

- **Deep zoom to 10⁻²⁰, and that number is measured** — direct iteration in a
  1080-row frame stops separating pixels below ~10⁻⁴ in `float32` and ~2×10⁻¹³ in
  `float64`; perturbation with a double-double reference orbit takes the CUDA
  renderer to an exact match with arbitrary precision at 10⁻¹⁶ and a handful of
  boundary pixels at 10⁻²⁰. The camera stops there, where the evidence stops
  ([depth sweep](paper/data/validation/depth_sweep.csv)).
- **One recurrence, two perturbation backends**: a WGSL fragment shader (WebGPU,
  `f32` deltas) and a native CUDA kernel (`f64` deltas), plus a WebGL2
  compatibility renderer that iterates directly and is *not* part of the
  deep-zoom pipeline.
- **Validated, not eyeballed**: CUDA renders are compared pixel-for-pixel against an
  independent `mpmath` arbitrary-precision implementation — which caught a real
  off-centre rebasing bug during development, and later a second one in the native
  path's orbit encoding.
- **Measured**: a nominal 1 168 GIter/s in the browser on an RTX 3060 Ti. That
  convention charges every pixel the full iteration cap; the machine really issues
  about 7% of it ([benchmarks below](#benchmarks)).

## Gallery

Every image links to the live demo with that exact view encoded in the URL —
the share-a-view feature demonstrating itself.

| | |
|:---:|:---:|
| [![c = -0.8 + 0.156i](docs/gallery/classic.jpg)](https://timmor77.github.io/FractalFlow/#x=0_0&y=0_0&s=3&cx=-0.8&cy=0.156&p=0) | [![c = 0.285 + 0.01i](docs/gallery/spirals.jpg)](https://timmor77.github.io/FractalFlow/#x=0_0&y=0_0&s=3&cx=0.285&cy=0.01&p=0) |
| `c = -0.8 + 0.156i` | `c = 0.285 + 0.01i` |
| [![c = -0.7269 + 0.1889i](docs/gallery/dendrites.jpg)](https://timmor77.github.io/FractalFlow/#x=0_0&y=0_0&s=3&cx=-0.7269&cy=0.1889&p=2) | [![c = -0.4 + 0.6i](docs/gallery/seahorse.jpg)](https://timmor77.github.io/FractalFlow/#x=0_0&y=0_0&s=3&cx=-0.4&cy=0.6&p=4) |
| `c = -0.7269 + 0.1889i` | `c = -0.4 + 0.6i` |

## Why perturbation theory?

Zooming far into a fractal is a *precision* problem. Adjacent pixels in a 1080-row
frame of height `s` are `s/1080` apart, and around `|z| = 1` consecutive `float32`
values are ~`1e-7` apart, `float64` values ~`2e-16`. Direct iteration therefore
stops separating neighbouring pixels below a view height of ~`1e-4` in `float32`
and ~`2e-13` in `float64` — sooner at higher resolution, later near the origin.
The trick that unlocks real depth is **perturbation**:

1. Compute the orbit of a single **reference point** (the view centre) **once on the
   CPU** in high precision (double-double, ~31 digits).
2. Every pixel then tracks only a tiny **delta** `δ` from that reference, in cheap
   `f32` (WebGPU) or `double` (CUDA).

For a Julia set `c` is constant, so the delta recurrence has **no `δc` term** and stays
beautifully simple:

```
z_n = Z[m] + δ                     // full value (Z = reference orbit)
δ'  = 2·Z[m]·δ + δ²                // advance the delta
```

Glitches and an escaping reference are handled with **Zhuoran rebasing**: when `δ` loses
precision (`|z − Z₀| < |δ|`) or the reference runs out, we restart from `Z[0]` with
`δ = z − Z₀`. The GPU never forms a pixel's exact coordinate as `centre + tiny offset`
in low precision — it gets the reference orbit and a small per-pixel delta — which is
why the shader is *simpler* than a naïve high-precision one, and much faster.

One subtlety, and the bug that took longest to find: the reference orbit is uploaded
**relative to Z₀** (`D[m] = Z[m] − Z₀`, subtracted in double-double). Absolute orbit
values would quantise the rebased delta `D[m] + δ` to the grid of O(1) numbers in the
upload format — ~`1e-7` in `f32`, ~`2e-16` in `f64`. Near a fixed point, where deltas
shrink with the zoom, neighbouring pixels then collapse onto the same delta and the
image dissolves into blocky noise: from ~`1e-5` down in the browser, from ~`1e-13` down
in CUDA. As offsets, both terms are small exactly when precision matters. Rendering the
same `1e-16` view with the absolute encoding misses **3 509 of 4 096 pixels**; with the
relative encoding it matches arbitrary precision **exactly**.

The high-precision centre is stored as a **double-double** value (two `float64`s, where
the second holds the rounding error of the first), giving ~31 digits. The camera's floor
is `1e-20`: not the representation's limit, but the deepest scale where the frozen
validation still holds (see [Correctness](#correctness)).

<p align="center">
  <img src="docs/deep-zoom.jpg" width="620"
       alt="In-browser render at ×1,000,000 zoom near a repelling fixed point of z²+c">
</p>

*Rendered in the browser at ×10⁶ zoom, centred on a repelling fixed point of
`z² + c` — a point that provably lies on the Julia set, so there is structure at
every depth.*

## Architecture

```
src/
  core/
    doubleDouble.ts     # double-double arithmetic (TwoSum / Dekker TwoProd)
    viewport.ts         # camera: DD centre, inertial zoom-at-cursor, pan
    referenceOrbit.ts   # perturbation reference orbit (shared idea across backends)
    types.ts            # Renderer interface + ViewState
    config.ts           # shared constants (c, iteration counts)
  backends/
    webgpu/             # primary: perturbation fragment shader in WGSL (f32)
    webgl/              # fallback: direct double-single shader in GLSL + driver probe
  bench/                # reproducible in-browser benchmark harness (open /?bench)
  controls/             # wheel / drag / pinch / keyboard → viewport
  ui/                   # palettes, Mandelbrot c-picker, stats overlay, panel
  main.ts               # picks WebGPU, falls back to WebGL2, runs the loop
cuda/
  julia.cu              # native renderer + benchmark (DD host orbit, f64 deltas)
scripts/
  reference_julia.py    # mpmath ground-truth renderer (validation) + CPU baseline
  benchmark.py          # benchmark CSVs → summary + charts
  make_zoom_gif.py      # renders the hero GIF via the CUDA backend
tests/                  # vitest suite for the math core
```

| Backend | Delta precision | Zoom floor | Role |
|---------|-----------------|------------|------|
| WebGPU  | `f32`, DD centre, relative orbit | `1e-20` (validated depth of the shared pipeline) | Primary browser renderer |
| CUDA    | `double`, DD centre, relative orbit | `1e-20`, exact match at `1e-16`, degrades past `1e-24` | Native renderer + benchmark |
| WebGL2  | double-single (`f32²`), direct iteration, no perturbation | `1e-13`, or `1e-4` when the start-up probe finds the compensated arithmetic optimised away | Shallow compatibility fallback, outside the validated pipeline |

## Benchmarks

Same view, schedule and counting convention on both GPU backends: 13 zoom depths from
`3` down to `3×10⁻¹²`, `maxIter = min(300 + 800k, 4000)`, at 1920×1080, on an
**RTX 3060 Ti**. Not the same *work*, though — the precisions differ by design, the
timing methods differ (see below), and the CPU baseline is a single shallow anchor
with colouring excluded.

![Iteration throughput vs zoom depth](docs/bench_giter.png)

The counter-intuitive headline: **the browser out-runs native CUDA by ~16×** here.
Not magic, and not a browser-versus-native result — the WebGPU shader iterates deltas
in `f32` while the CUDA kernel uses `f64`, and consumer Ampere executes fp64 at 1/64
of the fp32 rate. The measured gap is far *smaller* than that 64:1, because the `f32`
kernel is nowhere near its arithmetic ceiling (divergence and control flow dominate)
while the `f64` one is close to its own. That trade is what perturbation exploits: do
the precision-critical work once on the CPU, let the GPU crunch cheap deltas.

![Effective fill rate vs zoom depth](docs/bench_mpix.png)

Peak numbers, both at `scale = 3×10⁻⁶`: **1,168 GIter/s / 292 Mpix/s** (WebGPU,
f32) vs **70.8 GIter/s / 17.7 Mpix/s** (CUDA, f64), against **0.023 GIter/s** for
vectorized NumPy float64. The nominal CPU→GPU ratio is ~51 000×, but NumPy has no
early exit while the GPU rate charges iterations that never ran — correcting for
that (see below) puts the honest ratio nearer ~2 000×.

<details>
<summary><b>Methodology & how to reproduce</b></summary>

- The browser reports the median of 5 frames after 3 warm-ups per depth, timed with
  `device.queue.onSubmittedWorkDone()` on an off-screen render target (submission
  overhead included). CUDA reports the mean of 3 renders after 1 warm-up, with CUDA
  events around the kernel only. The CPU baseline times the vectorized iteration
  alone (colouring excluded).
- GIter/s counts `pixels × maxIter` and is therefore an *upper bound* (escaped pixels
  stop early). The convention is identical across backends, so backend-to-backend
  comparisons hold. How large the gap is: at the peak depth the average pixel escapes
  after 159 of the 4000 permitted iterations, i.e. 4% — measure it yourself with
  `python scripts/reference_julia.py --escape-stats`.
- The reference orbit is excluded from the timed region on both paths: cached in the
  browser, recomputed and uploaded before the events on CUDA. So these numbers are the
  cost of *redrawing* a view, not of opening a new one — a fresh view adds one CPU
  double-double orbit (a few ms at the iteration cap) plus its upload.
- Every sample includes a mean-luma readback to reject silently-black frames, and the
  WebGPU adapter/browser identity is recorded in its CSV header; the full host,
  driver and CUDA environment is frozen in `paper/data/environment.json`.
- The WebGL2 fallback is deliberately **excluded** from the charts: under ANGLE/D3D11
  its double-single compensated arithmetic is compiled with fast-math and collapses to
  plain `f32`, so beyond shallow depths its output no longer matches the validated
  backends — and throughput of a wrong image is meaningless. The app now detects this
  at start-up (a 1×1 probe shader), warns in the console and caps the zoom accordingly.
  On this machine the probe fails, which is why the fallback stops at `1e-4` here.
- One machine, one driver, one browser build. These curves rank two implementations on
  one desktop, not WebGPU against CUDA in general.

```bash
# 1) CUDA (writes artifacts/cuda_bench.csv)
cuda/julia.exe --bench --w 1920 --h 1080 --out artifacts/cuda_bench.csv

# 2) Browser: npm run dev, open http://localhost:5173/?bench,
#    download the CSV(s) into artifacts/

# 3) CPU baseline (writes artifacts/cpu_bench.csv)
uv run python scripts/reference_julia.py --bench

# 4) Charts (writes docs/bench_giter.png, docs/bench_mpix.png)
uv run python scripts/benchmark.py
```

</details>

## Correctness

The CUDA perturbation renderer is checked pixel-for-pixel against direct
arbitrary-precision iteration (`mpmath`, 50–90 digits) in six frozen 64×64 cases.
Each image is 4096 pixels; the release gate fails on a mean above 3 levels, on more
than 1% of pixels differing by more than 4 levels, or on more than 0.5% of
escaped/not-escaped flips.

| Case | Scale | Mean error | Pixels differing | By >4 levels |
|---|---|---|---|---|
| Overview | `3` | 0.0002 | 2 | 0 |
| Off-centre boundary | `3e-1` | 0.1695 | 24 | 11 |
| Deep zoom | `1e-5` | 0.0002 | 2 | 0 |
| Repelling fixed point | `1e-10` | **0** | **0** | 0 |
| Below binary64 | `1e-16` | **0** | **0** | 0 |
| Deepest validated | `1e-20` | 0.1442 | 20 | 9 |

Two cases match the arbitrary-precision reference *exactly*, including one four orders
of magnitude below what `float64` coordinates can address. The remaining differences
sit on escape-time boundaries where neighbouring pixels differ by hundreds of
iterations, so a one-ulp difference in the delta moves the colour a long way. Past the
frozen matrix, the archived
[depth sweep](paper/data/validation/depth_sweep.csv) shows the pipeline degrading
gracefully: ~3% of pixels wrong at `1e-24`, visibly broken at `1e-28`. That is why the
camera stops at `1e-20`.

The WebGPU path is now measured too, from the browser: `npm run dev`, then
`/?validate` re-renders the same cases with the `f32` shader and compares them against
the same references ([results](paper/data/validation/webgpu_validation.csv)). It is
measurably looser than CUDA — the `f32` deltas flip 0–2% of pixels between escaped and
not-escaped, worst at the deepest cases — and most of its whole-image difference comes
from sampling the palette through a 256-entry LUT rather than evaluating it
analytically. Interpret the browser as the fast path, CUDA as the accurate one.

Validation caught two real bugs. First, the rebasing step must restart with
`δ = z − Z₀`, not `δ = z`: the two are only equal when `Z₀ = 0` (the Mandelbrot case),
so the mistake was invisible at the origin and only showed up in off-centre deep zooms.
Second, the CUDA kernel used to upload the reference orbit in absolute coordinates,
which quantised the rebased delta below ~`1e-13`; the `1e-16` case above scores
3 509 wrong pixels out of 4 096 with that encoding and 0 with the relative one.

The CPU-side math core is additionally covered by a [vitest suite](tests/README.md):
the double-double arithmetic is verified against exact BigInt ground truth
(`hi + lo === a·b` for 50-bit integer products), and the camera satisfies a
zoom-at-cursor invariant through full animated zooms.

## Run it — browser

```bash
npm install
npm run dev        # open the printed localhost URL
npm test           # vitest: double-double, viewport, reference orbit
```

WebGPU is used when available (Chrome, Edge, recent Firefox/Safari); otherwise it falls
back to WebGL2 automatically. The active backend is shown in the on-screen stats.

**Controls:** mouse wheel = zoom to cursor · click-drag = pan · touch: one finger =
pan, pinch = zoom · `R` = reset · `S` = save PNG.

The bottom-right panel offers colour palettes, a mini-Mandelbrot map to pick the
Julia `c` (drag the marker or type values), full-quality PNG export (up to 8K), and a
**shareable link** — the view (centre, zoom, `c`, palette) lives in the URL hash.

## Run it — CUDA (NVIDIA)

Requires the CUDA Toolkit (`nvcc`) and a host C++ compiler — see [cuda/README.md](cuda/README.md).

```bash
cd cuda
nvcc -O3 julia.cu -o julia

# Render a PNG (full view):
./julia --w 1600 --h 1600 --iter 500 --scale 3 --out ../artifacts/cuda.png

# Deep zoom (centre accepts high-precision decimal strings, parsed to double-double):
./julia --re 0.0304 --im -0.564 --scale 6e-3 --iter 2500 --out ../artifacts/zoom.png

# Benchmark throughput across zoom depths (writes a CSV):
./julia --bench --w 1920 --h 1080 --out ../artifacts/cuda_bench.csv
```

## Run it — Python tooling (`uv`)

Python provides an **independent ground truth** to validate the GPU backends.

```bash
uv sync

# High-precision (mpmath) reference, compared to a CUDA render of the same view:
uv run python scripts/reference_julia.py --hp --w 64 --h 64 \
    --scale 1e-5 --re 0.0304 --im -0.564 --iter 700 \
    --compare artifacts/cuda_deepval.png

# CPU baseline for the benchmark charts:
uv run python scripts/reference_julia.py --bench

# CPU-only self-check (float64 vs mpmath) — what CI runs:
uv run python scripts/reference_julia.py --selftest

# Full release matrix (needs cuda/julia.exe), and the depth sweep behind the floor:
uv run python scripts/validate_release.py
uv run python scripts/validate_release.py --depth-sweep

# Benchmark CSVs -> summary + charts:
uv run python scripts/benchmark.py

# Hero GIF (requires the CUDA renderer):
uv run python scripts/make_zoom_gif.py
```

## Roadmap

Done: WebGL2 viewer → modular architecture → cursor-anchored inertial zoom → smooth
colouring → **WebGPU backend** → **perturbation deep zoom** → **CUDA renderer +
benchmark** → **mpmath validation** → interactive `c` + palettes → PNG export →
shareable URLs → touch/pinch → test suite + CI → cross-backend benchmarks →
**orbit-relative reference storage** in both perturbation backends (glitch-free
rebasing near fixed points) → **in-browser WebGPU validation** (`/?validate`) and a
measured zoom floor.

Next: quad-double centre for `1e-50+` zoom · series approximation to skip early
iterations · progressive/tiled rendering · comparing raw iteration state instead of
RGB, so the palette stops confounding the validation.

## Stack

TypeScript · Vite · WebGPU (WGSL) · WebGL2 (GLSL) · CUDA C · Python + `uv`
(NumPy, Pillow, mpmath, Matplotlib) · Vitest · GitHub Actions.

## Cite

The reproducible technical report
[*FractalFlow: Portable Deep-Zoom Julia Rendering with Perturbation Theory
across WebGPU and CUDA*](paper/main.pdf) documents the numerical method,
cross-backend design, validation protocol and benchmark limitations. Citation
metadata for GitHub and Zenodo is provided in [`CITATION.cff`](CITATION.cff)
and [`.zenodo.json`](.zenodo.json). DOI badges and the final BibTeX entry are
added only after the corresponding Zenodo records have been published.

## License

[Apache License 2.0](LICENSE) — free to use, modify and distribute, including
commercially, with attribution and an explicit patent grant. Copyright 2026
Timofei Amosov. `cuda/stb_image_write.h` keeps its own dual MIT/public-domain
license (nothings/stb).
