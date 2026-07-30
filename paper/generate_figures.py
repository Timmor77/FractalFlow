"""Generate every data-driven figure and table used by the report.

Figures are written without a PDF creation date so that a re-run on unchanged
inputs reproduces the byte-identical files listed in generated/manifest.json.
"""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch
from PIL import Image


PAPER = Path(__file__).resolve().parent
DATA = PAPER / "data"
FIGURES = PAPER / "figures"
GENERATED = PAPER / "generated"

# Suppresses the timestamp the PDF backend would otherwise embed.
NO_DATE = {"CreationDate": None}

COLORS = {
    "ink": "#172033",
    "muted": "#667085",
    "grid": "#d9dce3",
    "blue": "#2563eb",
    "green": "#16a34a",
    "orange": "#ea580c",
    "purple": "#7c3aed",
    "light_blue": "#dbeafe",
    "light_green": "#dcfce7",
    "light_orange": "#ffedd5",
    "light_purple": "#ede9fe",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_benchmark_csv(path: Path) -> list[dict[str, float]]:
    with path.open(newline="", encoding="utf-8") as stream:
        lines = [line for line in stream if not line.startswith("#")]
    return [
        {
            "scale": float(row["scale"]),
            "maxIter": float(row["maxIter"]),
            "ms": float(row["ms"]),
            "giter": float(row["GIterPerSec"]),
            "mpix": float(row["MpixPerSec"]),
        }
        for row in csv.DictReader(lines)
    ]


def add_box(
    ax: plt.Axes,
    x: float,
    y: float,
    width: float,
    height: float,
    title: str,
    subtitle: str,
    facecolor: str,
    dashed: bool = False,
) -> None:
    box = FancyBboxPatch(
        (x, y),
        width,
        height,
        boxstyle="round,pad=0.012,rounding_size=0.025",
        linewidth=1.3,
        linestyle="--" if dashed else "-",
        edgecolor=COLORS["muted"] if dashed else COLORS["ink"],
        facecolor=facecolor,
    )
    ax.add_patch(box)
    ax.text(
        x + width / 2,
        y + height * 0.62,
        title,
        ha="center",
        va="center",
        fontsize=10,
        fontweight="bold",
        color=COLORS["ink"],
    )
    ax.text(
        x + width / 2,
        y + height * 0.30,
        subtitle,
        ha="center",
        va="center",
        fontsize=8,
        color=COLORS["muted"],
    )


def add_arrow(
    ax: plt.Axes, start: tuple[float, float], end: tuple[float, float], label: str = ""
) -> None:
    arrow = FancyArrowPatch(
        start,
        end,
        arrowstyle="-|>",
        mutation_scale=14,
        linewidth=1.3,
        color=COLORS["ink"],
        connectionstyle="arc3",
    )
    ax.add_patch(arrow)
    if label:
        ax.text(
            (start[0] + end[0]) / 2,
            (start[1] + end[1]) / 2 + 0.035,
            label,
            ha="center",
            fontsize=7.5,
            color=COLORS["muted"],
        )


def architecture_figure() -> Path:
    """The pipeline, annotated with how far the evidence reaches.

    The dashed box is the point of the figure: the compatibility renderer takes
    the view state and nothing else, and nothing it produces reaches the
    evidence. Everything solid is covered by the archived comparisons.
    """
    fig, ax = plt.subplots(figsize=(10.4, 3.9))
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")

    add_box(ax, 0.02, 0.60, 0.19, 0.21, "View state",
            "DD centre, scale, c", COLORS["light_purple"])
    add_box(ax, 0.29, 0.60, 0.22, 0.21, "CPU reference orbit",
            "double-double; D[m] = Z[m] - Z0", COLORS["light_blue"])
    add_box(ax, 0.60, 0.72, 0.19, 0.19, "WebGPU / WGSL",
            "f32 deltas - compared in browser", COLORS["light_orange"])
    add_box(ax, 0.60, 0.47, 0.19, 0.19, "CUDA",
            "f64 deltas - pixel-validated", COLORS["light_green"])
    add_box(ax, 0.60, 0.06, 0.19, 0.19, "WebGL2 fallback",
            "direct double-single - not validated", "#f3f4f6", dashed=True)
    add_box(ax, 0.29, 0.20, 0.22, 0.21, "mpmath reference",
            "direct iteration, 50-90 dps", "#f3f4f6")
    add_box(ax, 0.85, 0.52, 0.13, 0.24, "Evidence",
            "PNG, CSV, hashes", "#fef3c7")

    add_arrow(ax, (0.21, 0.705), (0.29, 0.705), "once / view")
    add_arrow(ax, (0.51, 0.705), (0.60, 0.82), "upload")
    add_arrow(ax, (0.51, 0.68), (0.60, 0.58), "same recurrence")
    add_arrow(ax, (0.14, 0.60), (0.30, 0.42), "same view")
    add_arrow(ax, (0.79, 0.82), (0.85, 0.70))
    add_arrow(ax, (0.79, 0.57), (0.85, 0.63))
    add_arrow(ax, (0.51, 0.31), (0.85, 0.55))

    # The fallback takes the view state and feeds nothing back.
    ax.add_patch(FancyArrowPatch(
        (0.075, 0.595), (0.595, 0.155), arrowstyle="-|>", mutation_scale=14,
        linewidth=1.2, linestyle="--", color=COLORS["muted"],
        connectionstyle="angle,angleA=-90,angleB=180,rad=0",
    ))

    ax.text(0.5, 0.99, "FractalFlow measurement and validation pipeline",
            ha="center", va="top", fontsize=12, fontweight="bold", color=COLORS["ink"])
    ax.text(0.895, 0.44, "nothing from the dashed\npath reaches here",
            ha="center", va="top", fontsize=7.5, color=COLORS["muted"], style="italic")
    fig.tight_layout(pad=0.4)
    path = FIGURES / "architecture.pdf"
    fig.savefig(path, bbox_inches="tight", metadata=NO_DATE)
    plt.close(fig)
    return path


def precision_figure() -> Path:
    """The quantization mechanism, at both upload precisions.

    Same controlled experiment for binary32 and binary64: reconstruct a pixel
    offset from an orbit sample stored either absolutely or relative to Z0. The
    absolute form dies once the offset falls under the local spacing of the
    format; the relative form does not care how small the offset gets.
    """
    scales = np.logspace(-3, -20, 340)
    exact_delta = 0.37 * scales
    center = -0.5275031186435346  # the repelling fixed point of the test suite

    fig, ax = plt.subplots(figsize=(7.8, 4.05))
    styles = {
        np.float32: ("binary32", COLORS["orange"], COLORS["blue"], "-"),
        np.float64: ("binary64", COLORS["purple"], COLORS["green"], "--"),
    }
    for dtype, (name, absolute_color, relative_color, dashes) in styles.items():
        rounded_center = np.float64(dtype(center))
        absolute = (
            np.asarray(dtype(np.float64(dtype(center)) + exact_delta), dtype=np.float64)
            - rounded_center
        )
        relative = np.asarray(dtype(exact_delta), dtype=np.float64)

        absolute_error = np.abs(absolute - exact_delta) / np.abs(exact_delta)
        relative_error = np.maximum(
            np.abs(relative - exact_delta) / np.abs(exact_delta), np.finfo(float).tiny
        )
        ax.plot(scales, absolute_error, color=absolute_color, linewidth=2.1,
                linestyle=dashes, label=f"absolute {name} orbit")
        ax.plot(scales, relative_error, color=relative_color, linewidth=2.1,
                linestyle=dashes, label=f"relative {name} orbit")

    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.invert_xaxis()
    ax.set_ylim(1e-10, 3)
    ax.set_xlabel("delta magnitude (deeper zoom to the right)")
    ax.set_ylabel("relative reconstruction error")
    ax.grid(True, which="both", color=COLORS["grid"], alpha=0.7)
    ax.legend(loc="lower right", fontsize=8.2, ncol=2)
    ax.set_title("Reconstructing a pixel offset from an orbit sample")
    fig.tight_layout()
    path = FIGURES / "relative_orbit_precision.pdf"
    fig.savefig(path, metadata=NO_DATE)
    plt.close(fig)
    return path


def encoding_figure() -> Path:
    """How the orbit encoding decides the usable depth, over three scales.

    Same kernel, same view, same 700 iterations, one difference: whether the
    host uploads Z[m] or Z[m] - Z0. The top row is the CUDA kernel as it shipped
    before this release, the bottom row as it ships now. The failure is gradual
    — detail smears before the frame collapses — which is why it survived a
    validation matrix that stopped at 1e-10.
    """
    scales = ["1e-8", "1e-14", "1e-15", "1e-16"]
    exponents = {"1e-8": "-8", "1e-14": "-14", "1e-15": "-15", "1e-16": "-16"}

    fig, axes = plt.subplots(2, 4, figsize=(10.4, 5.7))
    for column, scale in enumerate(scales):
        images = {
            row: np.asarray(Image.open(DATA / "encoding" / f"{row}_{scale}.png").convert("RGB"))
            for row in ("absolute", "relative")
        }
        differing = 100.0 * (
            np.abs(images["absolute"].astype(int) - images["relative"].astype(int)).max(axis=2) > 0
        ).mean()
        colours = len(np.unique(images["absolute"].reshape(-1, 3), axis=0))
        note = (
            "one flat colour" if colours == 1
            else f"{differing:.0f}% of pixels differ" if differing > 20
            else "indistinguishable"
        )

        for row, key in enumerate(("absolute", "relative")):
            ax = axes[row][column]
            ax.imshow(images[key], interpolation="nearest")
            ax.set_xticks([])
            ax.set_yticks([])
            for spine in ax.spines.values():
                spine.set_edgecolor(COLORS["grid"])
            if row == 0:
                ax.set_title(f"$10^{{{exponents[scale]}}}$", fontsize=12, color=COLORS["ink"])
            else:
                ax.set_xlabel(note, fontsize=9, color=COLORS["muted"], labelpad=5)
            if column == 0:
                label = (
                    "absolute orbit\nupload" if key == "absolute" else "relative orbit\nupload"
                )
                ax.set_ylabel(label, fontsize=11, color=COLORS["ink"], labelpad=8)

    fig.suptitle(
        "Same kernel, same views, same 700 iterations: only the upload differs",
        fontsize=12.5,
        color=COLORS["ink"],
    )
    fig.tight_layout(rect=(0, 0, 1, 0.955))
    path = FIGURES / "orbit_encoding.pdf"
    fig.savefig(path, bbox_inches="tight", metadata=NO_DATE, dpi=200)
    plt.close(fig)
    return path


def depth_figure() -> Path:
    """Where the pipeline stops agreeing with arbitrary precision."""
    rows = []
    with (DATA / "validation" / "depth_sweep.csv").open(newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(line for line in stream if not line.startswith("#")):
            rows.append(row)
    scales = [float(row["scale"]) for row in rows]
    mean = [float(row["mean_abs_rgb"]) for row in rows]
    flips = [float(row["interior_flips_pct"]) for row in rows]

    fig, ax = plt.subplots(figsize=(7.6, 3.9))
    ax.plot(scales, mean, color=COLORS["blue"], marker="o", linewidth=2.0,
            label="mean absolute RGB error")
    ax.plot(scales, flips, color=COLORS["orange"], marker="s", linewidth=2.0,
            label="escaped/not-escaped flips (% of pixels)")
    ax.axvline(1e-20, color=COLORS["green"], linestyle="--", linewidth=1.4,
               label="camera floor ($10^{-20}$)")
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.invert_xaxis()
    ax.set_xlabel("view scale (deeper zoom to the right)")
    ax.set_ylabel("disagreement with mpmath")
    ax.set_title("CUDA against arbitrary precision, $64\\times64$, 1200 iterations")
    ax.grid(True, which="both", color=COLORS["grid"], alpha=0.7)
    ax.legend(fontsize=8.5, loc="upper left")
    fig.tight_layout()
    path = FIGURES / "depth_limit.pdf"
    fig.savefig(path, metadata=NO_DATE)
    plt.close(fig)
    return path


def benchmark_figure() -> tuple[Path, dict[str, list[dict[str, float]]]]:
    directory = DATA / "benchmark"
    styles = {
        "webgpu": ("WebGPU (f32 delta)", COLORS["blue"], "s"),
        "cuda": ("CUDA (f64 delta)", COLORS["green"], "o"),
    }
    data = {
        stem: read_benchmark_csv(directory / f"{stem}_bench.csv")
        for stem in ("webgpu", "cuda", "cpu")
    }

    fig, ax = plt.subplots(figsize=(8.2, 4.45))
    for stem in ("webgpu", "cuda"):
        label, color, marker = styles[stem]
        rows = data[stem]
        ax.plot(
            [row["scale"] for row in rows],
            [row["giter"] for row in rows],
            color=color,
            marker=marker,
            markersize=4.5,
            linewidth=1.9,
            label=label,
        )

    cpu_peak = max(row["giter"] for row in data["cpu"])
    ax.axhline(
        cpu_peak,
        color=COLORS["muted"],
        linestyle="--",
        linewidth=1.3,
        label=f"NumPy float64 ({cpu_peak:.3f} GIter/s)",
    )
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.invert_xaxis()
    ax.set_xlabel("view scale (deeper zoom to the right)")
    ax.set_ylabel("upper-bound iteration throughput (GIter/s)")
    ax.set_title("Measured throughput on one RTX 3060 Ti system, 1920 x 1080")
    ax.grid(True, which="both", color=COLORS["grid"], alpha=0.7)
    ax.legend(fontsize=8.8)
    fig.tight_layout()
    path = FIGURES / "benchmark_throughput.pdf"
    fig.savefig(path, metadata=NO_DATE)
    plt.close(fig)
    return path, data


def tex_scale(value: float) -> str:
    """Format a view scale as maths: 3e-06 -> $3{\\times}10^{-6}$, 3.0 -> $3$."""
    exponent = int(f"{value:e}".split("e")[1])
    mantissa = value / 10.0**exponent
    head = "" if abs(mantissa - 1.0) < 1e-9 else f"{mantissa:g}{{\\times}}"
    if exponent == 0:
        return f"${mantissa:g}$" if head else "$1$"
    return f"${head}10^{{{exponent}}}$"


def write_validation_table() -> Path:
    results = DATA / "validation" / "validation_results.csv"
    with results.open(newline="", encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))

    lines = [
        r"\begin{tabular}{@{}lrrrrrrrr@{}}",
        r"\toprule",
        r"Case & Scale & Iter.\ cap & Mean error & Max error "
        r"& Pixels differing & By $>4$ & Flips & Escape times \\",
        r"\midrule",
    ]
    for row in rows:
        label = str(row["label"]).replace("_", r"\_")
        pixels = int(row["width"]) * int(row["height"])
        # The CSV stores percentages; for a 64x64 case the pixel counts are the
        # readable form, and the conversion is exact.
        differing = round(pixels * (100.0 - float(row["identical_pixels_pct"])) / 100.0)
        above_four = round(pixels * (100.0 - float(row["matching_pixels_le4_pct"])) / 100.0)
        flips = round(pixels * float(row["interior_flips_pct"]) / 100.0)
        escape_off = round(pixels * float(row["raw_over_tolerance_pct"]) / 100.0)
        lines.append(
            f"{label} & {tex_scale(float(row['scale']))} & {int(row['max_iter'])} & "
            f"{float(row['mean_abs_rgb']):.6f} & "
            f"{int(float(row['max_abs_rgb']))} & "
            f"{differing} & {above_four} & {flips} & {escape_off} \\\\"
        )
    lines.extend([r"\bottomrule", r"\end{tabular}", ""])
    path = GENERATED / "validation_table.tex"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def write_benchmark_table(data: dict[str, list[dict[str, float]]]) -> Path:
    labels = {
        "webgpu": "WebGPU f32",
        "cuda": "CUDA f64",
        "cpu": "NumPy f64",
    }
    lines = [
        r"\begin{tabular}{@{}lrrrr@{}}",
        r"\toprule",
        r"Backend & Peak GIter/s & Mpix/s & Frame (ms) & Scale \\",
        r"\midrule",
    ]
    for stem in ("webgpu", "cuda", "cpu"):
        peak = max(data[stem], key=lambda row: row["giter"])
        lines.append(
            f"{labels[stem]} & {peak['giter']:.3f} & {peak['mpix']:.1f} & "
            f"{peak['ms']:.1f} & {tex_scale(peak['scale'])} \\\\"
        )
    lines.extend([r"\bottomrule", r"\end{tabular}", ""])
    path = GENERATED / "benchmark_table.tex"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def write_manifest(inputs: list[Path], outputs: list[Path]) -> Path:
    manifest = {
        "generator": "paper/generate_figures.py",
        "inputs": {
            str(path.relative_to(PAPER)).replace("\\", "/"): sha256(path)
            for path in inputs
        },
        "outputs": {
            str(path.relative_to(PAPER)).replace("\\", "/"): sha256(path)
            for path in outputs
        },
    }
    path = GENERATED / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return path


def main() -> None:
    FIGURES.mkdir(parents=True, exist_ok=True)
    GENERATED.mkdir(parents=True, exist_ok=True)

    architecture = architecture_figure()
    precision = precision_figure()
    encoding = encoding_figure()
    depth = depth_figure()
    benchmark, benchmark_data = benchmark_figure()
    validation_table = write_validation_table()
    benchmark_table = write_benchmark_table(benchmark_data)

    inputs = [
        DATA / "benchmark" / "webgpu_bench.csv",
        DATA / "benchmark" / "cuda_bench.csv",
        DATA / "benchmark" / "cpu_bench.csv",
        DATA / "validation" / "validation_results.csv",
        DATA / "validation" / "depth_sweep.csv",
        *sorted((DATA / "encoding").glob("*.png")),
    ]
    outputs = [
        architecture,
        precision,
        encoding,
        depth,
        benchmark,
        validation_table,
        benchmark_table,
    ]
    manifest = write_manifest(inputs, outputs)
    for path in [*outputs, manifest]:
        print(f"generated {path.relative_to(PAPER)}")


if __name__ == "__main__":
    main()
