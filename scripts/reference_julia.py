"""Renderer Julia de référence (CPU) — vérité terrain pour valider les backends GPU.

Deux méthodes d'itération DIRECTE de z = z² + c (pas de perturbation ici : c'est
justement l'intérêt, on valide la perturbation GPU contre un calcul indépendant) :

  --fast   numpy float64, vectorisé, rapide. Valable en zoom modéré (jusqu'à ~1e-13).
  (défaut) mpmath précision arbitraire. Lent mais valable à N'IMPORTE quelle profondeur.

Conventions IDENTIQUES au shader (src/backends/webgpu/julia.wgsl) et au CUDA
(cuda/julia.cu) : même mapping pixel→plan complexe, même rayon d'évasion, même
coloration lissée. On peut donc comparer les images au pixel près.

Exemples :
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


# Coloration lissée, strictement identique aux backends GPU.
def color(iter_count: int, mag2: float, max_iter: int) -> tuple[int, int, int]:
    if iter_count >= max_iter:
        return (0, 0, 0)  # intérieur
    nu = math.log2(0.5 * math.log2(mag2))
    t = (iter_count + 1.0 - nu) * 0.02
    tau = 6.2831853
    r = 0.5 + 0.5 * math.cos(tau * (0.00 + t))
    g = 0.5 + 0.5 * math.cos(tau * (0.33 + t))
    b = 0.5 + 0.5 * math.cos(tau * (0.67 + t))
    clamp = lambda v: max(0, min(255, int(v * 255.0)))
    return (clamp(r), clamp(g), clamp(b))


# Itération directe vectorisée en float64. Rapide, valable en zoom modéré.
def render_numpy(cx, cy, scale, jcx, jcy, max_iter, W, H) -> np.ndarray:
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

    img = np.zeros((H, W, 3), dtype=np.uint8)
    for y in range(H):
        for x in range(W):
            img[y, x] = color(int(it[y, x]), float(mag2[y, x]) if it[y, x] < max_iter else 0.0, max_iter)
    return img


# Itération directe en précision arbitraire (mpmath). Lente mais valable en deep zoom.
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
    p = argparse.ArgumentParser(description="Renderer Julia de référence (CPU)")
    p.add_argument("--w", type=int, default=300)
    p.add_argument("--h", type=int, default=300)
    p.add_argument("--iter", type=int, default=400)
    p.add_argument("--scale", type=float, default=3.0)
    p.add_argument("--re", default="0.0", help="centre réel (chaîne, haute précision possible)")
    p.add_argument("--im", default="0.0", help="centre imaginaire")
    p.add_argument("--cre", type=float, default=-0.8, help="paramètre c réel")
    p.add_argument("--cim", type=float, default=0.156, help="paramètre c imaginaire")
    p.add_argument("--fast", action="store_true", help="numpy float64 au lieu de mpmath")
    p.add_argument("--hp", action="store_true", help="mpmath (défaut si ni --fast ni --hp)")
    p.add_argument("--dps", type=int, default=40, help="chiffres de précision mpmath")
    p.add_argument("--out", default="artifacts/reference.png")
    p.add_argument("--compare", default=None, help="PNG GPU à comparer (même vue)")
    args = p.parse_args()

    use_numpy = args.fast and not args.hp
    if use_numpy:
        img = render_numpy(float(args.re), float(args.im), args.scale, args.cre, args.cim, args.iter, args.w, args.h)
        method = "numpy float64"
    else:
        img = render_mpmath(args.re, args.im, args.scale, args.cre, args.cim, args.iter, args.w, args.h, args.dps)
        method = f"mpmath dps={args.dps}"

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    Image.fromarray(img, "RGB").save(args.out)
    print(f"Référence {args.w}x{args.h} ({method}), scale={args.scale:.3e} -> {args.out}")

    if args.compare and os.path.exists(args.compare):
        gpu = np.asarray(Image.open(args.compare).convert("RGB"))
        if gpu.shape != img.shape:
            print(f"  comparaison impossible : tailles {gpu.shape} vs {img.shape}")
            return
        diff = np.abs(gpu.astype(np.int32) - img.astype(np.int32))
        mean_diff = diff.mean()
        # Fraction de pixels quasi identiques (diff <= 4 sur chaque canal).
        close = (diff.max(axis=2) <= 4).mean() * 100.0
        print(f"  vs {args.compare} : diff moyenne={mean_diff:.3f}/255, pixels concordants={close:.2f}%")
        print("  " + ("PASS" if mean_diff < 3.0 else "ÉCART NOTABLE (voir bords/coloration)"))


if __name__ == "__main__":
    main()
