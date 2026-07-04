"""Analyse le CSV de benchmark produit par le renderer CUDA (cuda/julia.cu --bench).

Lit artifacts/cuda_bench.csv, affiche un résumé et trace le débit en fonction de
la profondeur de zoom (artifacts/benchmark.png).

  uv run python scripts/benchmark.py
  uv run python scripts/benchmark.py --csv artifacts/cuda_bench.csv
"""

from __future__ import annotations

import argparse
import csv
import os

import matplotlib.pyplot as plt


def main() -> None:
    p = argparse.ArgumentParser(description="Analyse du benchmark CUDA")
    p.add_argument("--csv", default="artifacts/cuda_bench.csv")
    p.add_argument("--out", default="artifacts/benchmark.png")
    args = p.parse_args()

    if not os.path.exists(args.csv):
        raise SystemExit(
            f"{args.csv} introuvable. Génère-le d'abord :\n"
            "  cuda/julia.exe --bench --out artifacts/cuda_bench.csv"
        )

    scales, iters, ms, giter, mpix = [], [], [], [], []
    with open(args.csv, newline="") as f:
        for row in csv.DictReader(f):
            scales.append(float(row["scale"]))
            iters.append(int(row["maxIter"]))
            ms.append(float(row["ms"]))
            giter.append(float(row["GIterPerSec"]))
            mpix.append(float(row["MpixPerSec"]))

    print(f"{'scale':>12} {'iter':>7} {'ms':>9} {'GIter/s':>9} {'Mpix/s':>9}")
    for s, it, t, g, m in zip(scales, iters, ms, giter, mpix):
        print(f"{s:>12.2e} {it:>7} {t:>9.2f} {g:>9.2f} {m:>9.1f}")
    print(f"\nDébit crête : {max(giter):.1f} GIter/s, {max(mpix):.1f} Mpix/s")

    # Débit (GIter/s) en fonction de la profondeur de zoom (axe X inversé : deep à droite).
    fig, ax1 = plt.subplots(figsize=(8, 4.5))
    ax1.plot(scales, giter, "o-", color="#3b82f6", label="GIter/s")
    ax1.set_xscale("log")
    ax1.invert_xaxis()
    ax1.set_xlabel("scale (taille de vue) — deep zoom vers la droite")
    ax1.set_ylabel("GIter/s", color="#3b82f6")

    ax2 = ax1.twinx()
    ax2.plot(scales, mpix, "s--", color="#ef4444", label="Mpix/s")
    ax2.set_ylabel("Mpix/s", color="#ef4444")

    ax1.set_title("FractalFlow — débit CUDA vs profondeur de zoom (RTX 3060 Ti)")
    fig.tight_layout()
    fig.savefig(args.out, dpi=110)
    print(f"Graphe -> {args.out}")


if __name__ == "__main__":
    main()
