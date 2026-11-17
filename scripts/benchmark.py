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

each with a "-dark" twin for GitHub's dark theme.

Usage:
    uv run python scripts/benchmark.py [--gpu-label "RTX 3060 Ti"]
    uv run python scripts/benchmark.py --dir paper/data/benchmark   # the README charts
"""

from __future__ import annotations

import argparse
import csv
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

# (filename stem, display label, marker); colours are per theme, in LINE_COLOURS
# The delta precision matters when reading the charts: consumer Ampere runs
# fp64 at 1/64 of fp32 rate, which is why the browser's f32 perturbation
# out-runs native CUDA's f64 one.
BACKENDS = [
    ("cuda", "CUDA (native, f64 delta)", "o"),
    ("webgpu", "WebGPU (browser, f32 delta)", "s"),
    ("webgl2", "WebGL2 (browser fallback)", "^"),
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


def main() -> None:
    p = argparse.ArgumentParser(description="Plot FractalFlow benchmark CSVs")
    p.add_argument("--dir", default="artifacts", help="directory holding the CSVs")
    p.add_argument("--out", default="docs", help="output directory for the charts")
    p.add_argument("--gpu-label", default="RTX 3060 Ti", help="GPU name for the chart titles")
    args = p.parse_args()

    data: dict[str, list[dict[str, float]]] = {}
    for stem, label, _ in BACKENDS:
        path = os.path.join(args.dir, f"{stem}_bench.csv")
        if os.path.exists(path):
            data[stem] = read_csv(path)
            peak_giter = max(r["giter"] for r in data[stem])
            peak_mpix = max(r["mpix"] for r in data[stem])
            print(
                f"{label:28s} peak {peak_giter:7.2f} GIter/s, {peak_mpix:8.1f} Mpix/s "
                f"({len(data[stem])} depths)"
            )
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
    title_suffix = f"{args.gpu_label}, 1920×1080"
    for theme, suffix in (("light", ""), ("dark", "-dark")):
        plot(
            data,
            "giter",
            "GIter/s (perturbation iterations, upper bound, log)",
            f"Iteration throughput vs zoom depth, {title_suffix}",
            os.path.join(args.out, f"bench_giter{suffix}.png"),
            theme,
            cpu_giter,
        )
        plot(
            data,
            "mpix",
            "effective Mpix/s (log)",
            f"Fill rate vs zoom depth, {title_suffix}",
            os.path.join(args.out, f"bench_mpix{suffix}.png"),
            theme,
        )


# Colours per theme. The dark set matches GitHub's dark page background, so the
# README can swap charts with <picture> and prefers-color-scheme.
THEMES = {
    "light": {"bg": "#ffffff", "fg": "#1f2328", "muted": "#59636e", "grid": "#d1d9e0"},
    "dark": {"bg": "#0d1117", "fg": "#f0f6fc", "muted": "#9198a1", "grid": "#3d444d"},
}
LINE_COLOURS = {
    "light": {"cuda": "#2da44e", "webgpu": "#0969da", "webgl2": "#bc4c00"},
    "dark": {"cuda": "#3fb950", "webgpu": "#4493f8", "webgl2": "#f0883e"},
}


def plot(
    data: dict[str, list[dict[str, float]]],
    key: str,
    ylabel: str,
    title: str,
    path: str,
    theme: str,
    cpu_giter: float | None = None,
) -> None:
    """One chart, log-log, deeper zoom to the right, at 2× for high-density screens."""
    t = THEMES[theme]
    with plt.rc_context(
        {
            "text.color": t["fg"],
            "axes.labelcolor": t["fg"],
            "axes.edgecolor": t["muted"],
            "xtick.color": t["fg"],
            "ytick.color": t["fg"],
            "font.size": 10,
        }
    ):
        fig, ax = plt.subplots(figsize=(8, 4.5), dpi=300)
        fig.patch.set_facecolor(t["bg"])
        ax.set_facecolor(t["bg"])
        for stem, label, marker in BACKENDS:
            if stem in data:
                rows = data[stem]
                ax.plot(
                    [r["scale"] for r in rows],
                    [r[key] for r in rows],
                    color=LINE_COLOURS[theme][stem],
                    marker=marker,
                    markersize=5,
                    linewidth=1.8,
                    label=label,
                )
        if cpu_giter is not None:
            ax.axhline(cpu_giter, color=t["muted"], linestyle="--", linewidth=1.2)
            ax.annotate(
                f"NumPy float64 (CPU, vectorized): {cpu_giter:.3f} GIter/s",
                xy=(0.02, cpu_giter),
                xycoords=("axes fraction", "data"),
                textcoords="offset points",
                xytext=(0, 5),
                fontsize=8,
                color=t["muted"],
            )
        ax.set_xscale("log")
        ax.invert_xaxis()  # deep zoom towards the right
        ax.set_xlabel("view scale (complex-plane height), deeper zoom →")
        ax.grid(color=t["grid"], linewidth=0.8)
        ax.set_axisbelow(True)
        ax.set_yscale("log")
        ax.set_ylabel(ylabel)
        ax.set_title(title)
        legend = ax.legend(loc="best", fontsize=9, facecolor=t["bg"], edgecolor=t["grid"])
        for text in legend.get_texts():
            text.set_color(t["fg"])
        fig.tight_layout()
        fig.savefig(path, facecolor=t["bg"])
        plt.close(fig)
    print(f"-> {path}")

if __name__ == "__main__":
    main()
