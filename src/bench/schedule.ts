// Shared benchmark schedule — the single source of truth for the browser
// harness. It mirrors the CUDA benchmark (cuda/julia.cu, runBenchmark):
// 13 depths, scale = 3×10⁻ᵏ, maxIter = min(300 + 800k, 4000), at 1920×1080.
//
// The 4000 cap is MAX_ITER_LIMIT (core/config.ts): it sizes the reference
// orbit buffer, and clamping CUDA to the same value keeps the per-pixel work
// — hence Mpix/s — directly comparable across backends.

import { MAX_ITER_LIMIT } from "../core/config";

export const BENCH_WIDTH = 1920;
export const BENCH_HEIGHT = 1080;

// Boundary-region centre => long reference orbits (realistic deep-zoom load).
// Same point as the CUDA benchmark's default --re/--im.
export const BENCH_CENTER = { x: 0.76, y: 0.24 };
export const BENCH_C = { x: -0.8, y: 0.156 };

export type BenchPoint = {
  scale: number;
  maxIter: number;
};

export const BENCH_SCHEDULE: BenchPoint[] = Array.from({ length: 13 }, (_, k) => ({
  scale: 3 * 10 ** -k,
  maxIter: Math.min(300 + 800 * k, MAX_ITER_LIMIT),
}));
