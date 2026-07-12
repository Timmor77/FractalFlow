"""Renders the README hero GIF: a continuous deep zoom into the Julia set.

Frames are rendered with the CUDA renderer (build it first: see cuda/README.md)
at --ss times the target size, downscaled with Lanczos (the supersampling is
what turns the shimmering sub-pixel filaments into smooth antialiased detail),
then quantized to a SHARED palette (built from a mid-zoom frame) so the GIF
does not flicker between frames. The zoom is interpolated in log space for a
constant perceived speed.

The README shows the GIF at its native width: keep --width in sync with the
`<img width=...>` attribute there, otherwise browser upscaling blurs it.

Usage:
    uv run python scripts/make_zoom_gif.py
    uv run python scripts/make_zoom_gif.py --frames 80 --width 480 --height 270 --colors 128
"""

from __future__ import annotations

import argparse
import math
import os
import subprocess
import sys
import tempfile

from PIL import Image


def main() -> None:
    p = argparse.ArgumentParser(description="Render the deep-zoom hero GIF")
    p.add_argument("--exe", default=os.path.join("cuda", "julia.exe" if os.name == "nt" else "julia"))
    # The default target is the repelling fixed point of z² + c (computed with
    # mpmath to 40 digits; --re/--im are parsed to double-double). It provably
    # lies ON the Julia set, so there is structure at every depth — a centre
    # merely *near* the set drifts off it and goes blank past ~1e-6.
    p.add_argument(
        "--re", default="1.527503118643534610789746402444915337567",
        help="zoom target, real part (must lie on the Julia set)",
    )
    p.add_argument(
        "--im", default="-0.07591217835228786707181419482634804636642",
        help="zoom target, imaginary part",
    )
    p.add_argument("--cre", type=float, default=-0.8)
    p.add_argument("--cim", type=float, default=0.156)
    p.add_argument("--start-scale", type=float, default=3.0)
    p.add_argument("--end-scale", type=float, default=1e-9)
    p.add_argument("--frames", type=int, default=100)
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=360)
    p.add_argument("--colors", type=int, default=256)
    p.add_argument("--duration", type=int, default=60, help="ms per frame")
    p.add_argument("--ss", type=int, default=3, help="supersampling factor")
    p.add_argument(
        "--dither",
        choices=["none", "fs"],
        default="none",
        help="none: crisp + compresses ~2x better (256 colours hide the banding); "
        "fs: Floyd-Steinberg, whose per-frame noise shimmers in motion",
    )
    p.add_argument("--out", default=os.path.join("docs", "zoom.gif"))
    args = p.parse_args()

    if not os.path.exists(args.exe):
        sys.exit(f"{args.exe} not found — build the CUDA renderer first (see cuda/README.md)")

    log_start = math.log(args.start_scale)
    log_end = math.log(args.end_scale)

    frames: list[Image.Image] = []
    with tempfile.TemporaryDirectory() as tmp:
        for k in range(args.frames):
            t = k / (args.frames - 1)
            scale = math.exp(log_start + (log_end - log_start) * t)
            # Same adaptive-iteration idea as the browser (core/config.ts).
            zoom_level = max(0.0, math.log2(args.start_scale / scale))
            max_iter = min(300 + int(45 * zoom_level), 4000)

            path = os.path.join(tmp, f"f{k:03d}.png")
            subprocess.run(
                [
                    args.exe,
                    "--w", str(args.width * args.ss),
                    "--h", str(args.height * args.ss),
                    "--iter", str(max_iter),
                    "--scale", f"{scale:.8e}",
                    "--re", args.re,
                    "--im", args.im,
                    "--cre", str(args.cre),
                    "--cim", str(args.cim),
                    "--out", path,
                ],
                check=True,
                stdout=subprocess.DEVNULL,
            )
            frame = Image.open(path).convert("RGB")
            frames.append(frame.resize((args.width, args.height), Image.LANCZOS))
            print(f"\rframe {k + 1}/{args.frames} (scale {scale:.1e}, iter {max_iter})", end="", flush=True)
    print()

    # Shared palette from a mid-zoom frame: avoids per-frame palette flicker.
    dither = Image.FLOYDSTEINBERG if args.dither == "fs" else Image.NONE
    reference = frames[len(frames) // 2].quantize(colors=args.colors, method=Image.MEDIANCUT)
    quantized = [f.quantize(colors=args.colors, palette=reference, dither=dither) for f in frames]

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    quantized[0].save(
        args.out,
        save_all=True,
        append_images=quantized[1:],
        duration=args.duration,
        loop=0,
        optimize=True,
    )
    size_mb = os.path.getsize(args.out) / 1e6
    print(f"-> {args.out} ({size_mb:.2f} MB, {args.frames} frames, {args.colors} colours)")
    # GitHub's image proxy (camo) refuses files around 10 MB; stay well under.
    if size_mb > 8.5:
        print("Over the 8.5 MB budget — retry with fewer frames / smaller size / fewer colours.")


if __name__ == "__main__":
    main()
