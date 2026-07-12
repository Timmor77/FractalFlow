"""Benchmark plotting: turns the per-backend CSVs into the README charts.

Reads whichever of these exist in artifacts/ (all share the same schedule and
CSV columns — see cuda/julia.cu --bench and the in-browser harness at /?bench):

    cuda_bench.csv     native CUDA renderer
    webgpu_bench.csv   browser WebGPU backend
    webgl2_bench.csv   browser WebGL2 fallback
    cpu_bench.csv      NumPy float64 baseline (scripts/reference_julia.py --bench)

Prints a summary table and writes two charts to docs/:

    docs/bench_giter.png   GIter/s vs zoom depth (the headline chart)
    docs/bench_mpix.png    effective Mpix/s vs zoom depth (log scale)

Usage:
    uv run python scripts/benchmark.py [--gpu-label "RTX 3060 Ti"]
"""

from __future__ import annotations

import argparse
import csv
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

# (filename stem, display label, colour, marker)
# The delta precision matters when reading the charts: consumer Ampere runs
# fp64 at 1/64 of fp32 rate, which is why the browser's f32 perturbation
# out-runs native CUDA's f64 one.
BACKENDS = [
    ("cuda", "CUDA (native, f64 delta)", "tab:green", "o"),
    ("webgpu", "WebGPU (browser, f32 delta)", "tab:blue", "s"),
    ("webgl2", "WebGL2 (browser fallback)", "tab:orange", "^"),
]


def read_csv(path: str) -> list[dict[str, float]]:
    """Reads a benchmark CSV, skipping '#' comment lines."""
    with open(path, newline="") as f:
        lines = [line for line in f if not line.startswith("#")]
    rows = []
    for row in csv.DictReader(lines):
        rows.append(
            {
                "scale": float(row["scale"]),
                "maxIter": float(row["maxIter"]),
                "ms": float(row["ms"]),
                "giter": float(row["GIterPerSec"]),
                "mpix": float(row["MpixPerSec"]),
            }
        )
    return rows


def style_axes(ax) -> None:
    ax.set_xscale("log")
    ax.invert_xaxis()  # deep zoom towards the right
    ax.set_xlabel("view scale (complex-plane height) — deeper zoom →")
    ax.grid(alpha=0.3)


def main() -> None:
    p = argparse.ArgumentParser(description="Plot FractalFlow benchmark CSVs")
    p.add_argument("--dir", default="artifacts", help="directory holding the CSVs")
    p.add_argument("--out", default="docs", help="output directory for the charts")
    p.add_argument("--gpu-label", default="RTX 3060 Ti", help="GPU name for the chart titles")
    args = p.parse_args()

    data: dict[str, list[dict[str, float]]] = {}
    for stem, label, _, _ in BACKENDS:
        path = os.path.join(args.dir, f"{stem}_bench.csv")
        if os.path.exists(path):
            data[stem] = read_csv(path)
            peak_giter = max(r["giter"] for r in data[stem])
            peak_mpix = max(r["mpix"] for r in data[stem])
            print(f"{label:28s} peak {peak_giter:7.2f} GIter/s, {peak_mpix:8.1f} Mpix/s ({len(data[stem])} depths)")
        else:
            print(f"{label:28s} (no {path}, skipped)")

    cpu_path = os.path.join(args.dir, "cpu_bench.csv")
    cpu_giter = None
    if os.path.exists(cpu_path):
        cpu_rows = read_csv(cpu_path)
        cpu_giter = max(r["giter"] for r in cpu_rows)
        print(f"{'NumPy float64 (CPU)':28s} peak {cpu_giter:7.3f} GIter/s")

    if not data:
        print("Nothing to plot. Run the benchmarks first (see README, Benchmarks section).")
        return

    os.makedirs(args.out, exist_ok=True)

    # --- Chart 1: GIter/s vs depth (headline) ---
    fig, ax = plt.subplots(figsize=(8, 4.5), dpi=150)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    for stem, label, color, marker in BACKENDS:
        if stem in data:
            rows = data[stem]
            ax.plot(
                [r["scale"] for r in rows],
                [r["giter"] for r in rows],
                color=color,
                marker=marker,
                markersize=5,
                linewidth=1.8,
                label=label,
            )
    if cpu_giter is not None:
        ax.axhline(cpu_giter, color="grey", linestyle="--", linewidth=1.2)
        ax.annotate(
            f"NumPy float64 (CPU, vectorized): {cpu_giter:.3f} GIter/s",
            xy=(0.02, cpu_giter),
            xycoords=("axes fraction", "data"),
            textcoords="offset points",
            xytext=(0, 5),
            fontsize=8,
            color="dimgrey",
        )
    style_axes(ax)
    ax.set_yscale("log")
    ax.set_ylabel("GIter/s (perturbation iterations, upper bound, log)")
    ax.set_title(f"Iteration throughput vs zoom depth — {args.gpu_label}, 1920×1080")
    ax.legend(loc="best", fontsize=9)
    fig.tight_layout()
    giter_path = os.path.join(args.out, "bench_giter.png")
    fig.savefig(giter_path, facecolor="white")
    print(f"-> {giter_path}")

    # --- Chart 2: effective Mpix/s vs depth ---
    fig, ax = plt.subplots(figsize=(8, 4.5), dpi=150)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    for stem, label, color, marker in BACKENDS:
        if stem in data:
            rows = data[stem]
            ax.plot(
                [r["scale"] for r in rows],
                [r["mpix"] for r in rows],
                color=color,
                marker=marker,
                markersize=5,
                linewidth=1.8,
                label=label,
            )
    style_axes(ax)
    ax.set_yscale("log")
    ax.set_ylabel("effective Mpix/s (log)")
    ax.set_title(f"Fill rate vs zoom depth — {args.gpu_label}, 1920×1080")
    ax.legend(loc="best", fontsize=9)
    fig.tight_layout()
    mpix_path = os.path.join(args.out, "bench_mpix.png")
    fig.savefig(mpix_path, facecolor="white")
    print(f"-> {mpix_path}")


if __name__ == "__main__":
    main()
