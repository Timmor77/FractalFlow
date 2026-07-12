"""Reference Julia renderer (CPU) — ground truth for validating the GPU backends.

Two DIRECT iteration methods for z = z² + c (no perturbation here: that is the
whole point — the GPU perturbation is validated against an independent
computation):

  --fast    numpy float64, vectorized, fast. Valid at moderate zoom (down to ~1e-13).
  (default) mpmath arbitrary precision. Slow but valid at ANY depth.

Conventions IDENTICAL to the shader (src/backends/webgpu/julia.wgsl) and to
CUDA (cuda/julia.cu): same pixel→complex-plane mapping, same escape radius,
same smooth colouring. Images can therefore be compared pixel by pixel.

Examples:
  uv run python scripts/reference_julia.py --w 300 --h 300 --iter 400 \
      --scale 3 --re 0 --im 0 --out artifacts/reference.png --compare artifacts/cuda_val.png
  uv run python scripts/reference_julia.py --hp --w 80 --h 80 --scale 1e-8 \
      --re 0.0304 --im -0.564 --iter 1500
"""

from __future__ import annotations

import argparse
import math
import os

import numpy as np
from PIL import Image


# Smooth colouring, strictly identical to the GPU backends.
def color(iter_count: int, mag2: float, max_iter: int) -> tuple[int, int, int]:
    if iter_count >= max_iter:
        return (0, 0, 0)  # interior
    nu = math.log2(0.5 * math.log2(mag2))
    t = (iter_count + 1.0 - nu) * 0.02
    tau = 6.2831853
    r = 0.5 + 0.5 * math.cos(tau * (0.00 + t))
    g = 0.5 + 0.5 * math.cos(tau * (0.33 + t))
    b = 0.5 + 0.5 * math.cos(tau * (0.67 + t))
    clamp = lambda v: max(0, min(255, int(v * 255.0)))
    return (clamp(r), clamp(g), clamp(b))


# Vectorized direct iteration in float64. Fast, valid at moderate zoom.
# Returns the raw (iteration count, |z|²) grids; colouring is separate so the
# CPU benchmark can time the iteration alone.
def iterate_numpy(cx, cy, scale, jcx, jcy, max_iter, W, H) -> tuple[np.ndarray, np.ndarray]:
    aspect = W / H
    ux, uy = np.meshgrid((np.arange(W) + 0.5) / W, (np.arange(H) + 0.5) / H)
    zx = cx + (ux - 0.5) * aspect * scale
    zy = cy + (0.5 - uy) * scale

    it = np.full((H, W), max_iter, dtype=np.int32)
    mag2 = np.zeros((H, W))
    alive = np.ones((H, W), dtype=bool)

    for i in range(max_iter):
        x2, y2 = zx * zx, zy * zy
        m = x2 + y2
        escaped = alive & (m > 4.0)
        it[escaped] = i
        mag2[escaped] = m[escaped]
        alive &= ~escaped
        nzx = x2 - y2 + jcx
        nzy = 2.0 * zx * zy + jcy
        zx = np.where(alive, nzx, zx)
        zy = np.where(alive, nzy, zy)

    return it, mag2


def colorize(it: np.ndarray, mag2: np.ndarray, max_iter: int) -> np.ndarray:
    H, W = it.shape
    img = np.zeros((H, W, 3), dtype=np.uint8)
    for y in range(H):
        for x in range(W):
            img[y, x] = color(int(it[y, x]), float(mag2[y, x]) if it[y, x] < max_iter else 0.0, max_iter)
    return img


def render_numpy(cx, cy, scale, jcx, jcy, max_iter, W, H) -> np.ndarray:
    it, mag2 = iterate_numpy(cx, cy, scale, jcx, jcy, max_iter, W, H)
    return colorize(it, mag2, max_iter)


# CPU baseline for the benchmark charts: times the vectorized float64 iteration
# (colouring excluded) at the first schedule point of the GPU benchmarks
# (scale 3, 300 iterations, 1920×1080). One shallow anchor point is enough to
# show the GPU-vs-CPU gap; deep points would only add wall-clock pain.
def run_cpu_bench(out_path: str) -> None:
    import time

    W, H, max_iter, scale = 1920, 1080, 300, 3.0
    # Same boundary centre and c as the GPU benchmarks (see src/bench/schedule.ts).
    cx, cy, jcx, jcy = 0.76, 0.24, -0.8, 0.156

    iterate_numpy(cx, cy, scale, jcx, jcy, max_iter, W, H)  # warm-up
    times = []
    for _ in range(3):
        t0 = time.perf_counter()
        iterate_numpy(cx, cy, scale, jcx, jcy, max_iter, W, H)
        times.append(time.perf_counter() - t0)
    seconds = sorted(times)[1]  # median of 3

    pixels = W * H
    giter = pixels * max_iter / seconds / 1e9  # upper bound, same convention as GPU
    mpix = pixels / seconds / 1e6
    print(f"CPU baseline (numpy float64): {seconds * 1e3:.0f} ms, {giter:.3f} GIter/s, {mpix:.2f} Mpix/s")

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w") as f:
        f.write("# backend: numpy-f64 (vectorized direct iteration, colouring excluded)\n")
        f.write("scale,maxIter,ms,GIterPerSec,MpixPerSec\n")
        f.write(f"{scale:.6e},{max_iter},{seconds * 1e3:.3f},{giter:.3f},{mpix:.1f}\n")
    print(f"CSV -> {out_path}")


# Direct iteration in arbitrary precision (mpmath). Slow but valid in deep zoom.
def render_mpmath(cx_str, cy_str, scale, jcx, jcy, max_iter, W, H, dps) -> np.ndarray:
    from mpmath import mp, mpf

    mp.dps = dps
    cx, cy, sc = mpf(cx_str), mpf(cy_str), mpf(str(scale))
    jcx_m, jcy_m = mpf(str(jcx)), mpf(str(jcy))
    aspect = mpf(W) / mpf(H)

    img = np.zeros((H, W, 3), dtype=np.uint8)
    for y in range(H):
        uy = (mpf(y) + mpf("0.5")) / mpf(H)
        for x in range(W):
            ux = (mpf(x) + mpf("0.5")) / mpf(W)
            zx = cx + (ux - mpf("0.5")) * aspect * sc
            zy = cy + (mpf("0.5") - uy) * sc
            it, mag2 = max_iter, 0.0
            for i in range(max_iter):
                x2, y2 = zx * zx, zy * zy
                m = x2 + y2
                if m > 4:
                    it, mag2 = i, float(m)
                    break
                zx, zy = x2 - y2 + jcx_m, 2 * zx * zy + jcy_m
            img[y, x] = color(it, mag2, max_iter)
    return img


def main() -> None:
    p = argparse.ArgumentParser(description="Reference Julia renderer (CPU)")
    p.add_argument("--w", type=int, default=300)
    p.add_argument("--h", type=int, default=300)
    p.add_argument("--iter", type=int, default=400)
    p.add_argument("--scale", type=float, default=3.0)
    p.add_argument("--re", default="0.0", help="real centre (string, high precision allowed)")
    p.add_argument("--im", default="0.0", help="imaginary centre")
    p.add_argument("--cre", type=float, default=-0.8, help="real part of c")
    p.add_argument("--cim", type=float, default=0.156, help="imaginary part of c")
    p.add_argument("--fast", action="store_true", help="numpy float64 instead of mpmath")
    p.add_argument("--hp", action="store_true", help="mpmath (default if neither --fast nor --hp)")
    p.add_argument("--dps", type=int, default=40, help="mpmath precision digits")
    p.add_argument("--out", default="artifacts/reference.png")
    p.add_argument("--compare", default=None, help="GPU PNG to compare against (same view)")
    p.add_argument("--bench", action="store_true",
                   help="time the numpy iteration (CPU baseline) and write artifacts/cpu_bench.csv")
    args = p.parse_args()

    if args.bench:
        run_cpu_bench("artifacts/cpu_bench.csv")
        return

    use_numpy = args.fast and not args.hp
    if use_numpy:
        img = render_numpy(float(args.re), float(args.im), args.scale, args.cre, args.cim, args.iter, args.w, args.h)
        method = "numpy float64"
    else:
        img = render_mpmath(args.re, args.im, args.scale, args.cre, args.cim, args.iter, args.w, args.h, args.dps)
        method = f"mpmath dps={args.dps}"

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    Image.fromarray(img, "RGB").save(args.out)
    print(f"Reference {args.w}x{args.h} ({method}), scale={args.scale:.3e} -> {args.out}")

    if args.compare and os.path.exists(args.compare):
        gpu = np.asarray(Image.open(args.compare).convert("RGB"))
        if gpu.shape != img.shape:
            print(f"  cannot compare: sizes {gpu.shape} vs {img.shape}")
            return
        diff = np.abs(gpu.astype(np.int32) - img.astype(np.int32))
        mean_diff = diff.mean()
        # Fraction of near-identical pixels (diff <= 4 on every channel).
        close = (diff.max(axis=2) <= 4).mean() * 100.0
        print(f"  vs {args.compare}: mean diff={mean_diff:.3f}/255, matching pixels={close:.2f}%")
        print("  " + ("PASS" if mean_diff < 3.0 else "NOTABLE MISMATCH (check edges/colouring)"))


if __name__ == "__main__":
    main()
