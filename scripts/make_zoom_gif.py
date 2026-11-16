"""Renders the README hero animation: a continuous deep zoom into the Julia set.

The camera starts on the whole set and dives to --end-scale (3e-15 by default,
past the ~2e-13 where direct float64 iteration stops separating pixels). The
path is defined here, once, and can be drawn by either GPU backend:

- CUDA (default): each frame is rendered by the native renderer (build it
  first: see cuda/README.md).
- Any other renderer: --frames-dir assembles frames rendered elsewhere (one
  image per frame, sorted by name, at --ss times the target size) along the
  path printed by --print-path. The committed animation was made this way with the
  WebGPU backend, through its off-screen tile path (Renderer.renderTile).

Frames are downscaled with Lanczos (the supersampling turns shimmering
sub-pixel filaments into smooth antialiased detail), stamped with the current
magnification, then written as a lossy animated WebP (the default: GitHub and
every current browser play it, at a fraction of a GIF's size on this detail) or
as a GIF quantized to ONE palette built from frames spread over the whole zoom,
so colours neither flicker nor drift as the palette cycles.

The zoom is log-linear with eased ends. The centre glides from the origin to the
target while the whole set is in view, so the first frame is the full set,
centred, rather than the set pushed to one side.

The README shows the animation at its native width: keep --width in sync with the
`<img width=...>` attribute there, otherwise browser upscaling blurs it.

Usage:
    uv run python scripts/make_zoom_gif.py
    uv run python scripts/make_zoom_gif.py --print-path > path.csv
    uv run python scripts/make_zoom_gif.py --frames-dir path/to/frames
"""

from __future__ import annotations

import argparse
import glob
import math
import os
import subprocess
import sys
import tempfile

from mpmath import mp, mpf, nstr
from PIL import Image, ImageDraw, ImageFont

mp.dps = 50

SUPERSCRIPT = str.maketrans("0123456789-", "⁰¹²³⁴⁵⁶⁷⁸⁹⁻")


def camera_path(args: argparse.Namespace) -> list[tuple[float, str, str, int]]:
    """(scale, centre re, centre im, maxIter) for every frame.

    The centre is returned as decimal strings so it keeps its 40 digits; the
    CUDA renderer parses them to double-double.
    """
    log_start = math.log(args.start_scale)
    log_end = math.log(args.end_scale)
    target_re, target_im = mpf(args.re), mpf(args.im)
    path = []
    for k in range(args.frames):
        t = k / (args.frames - 1)
        # Mostly smoothstep (eased start and stop), a little linear so the
        # first frames already move.
        u = 0.15 * t + 0.85 * t * t * (3 - 2 * t)
        scale = math.exp(log_start + (log_end - log_start) * u)
        # Offset from the target, shrinking as scale^1.5: the target sits at
        # its natural place in the first frame and reaches the centre quickly.
        glide = mpf(min(1.0, scale / args.start_scale)) ** mpf(1.5)
        centre_re = target_re * (1 - glide)
        centre_im = target_im * (1 - glide)
        # Same adaptive iteration count as the browser (core/config.ts).
        zoom_level = max(0.0, math.log2(args.start_scale / scale))
        max_iter = min(300 + int(45 * zoom_level), 4000)
        path.append((scale, nstr(centre_re, 40), nstr(centre_im, 40), max_iter))
    return path


# Fonts with "×", "·" and superscript digits, by platform. Without one the
# label falls back to plain ASCII ("x3.3e12").
FONT_CANDIDATES = [
    "/System/Library/Fonts/Helvetica.ttc",
    "C:/Windows/Fonts/segoeui.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def load_font(size: int) -> tuple[ImageFont.FreeTypeFont | ImageFont.ImageFont, bool]:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size), True
    return ImageFont.load_default(size=size), False


def magnification_label(scale: float, start_scale: float, unicode: bool) -> str:
    zoom = start_scale / scale
    if zoom < 1000:
        return f"×{zoom:.0f}" if unicode else f"x{zoom:.0f}"
    exponent = math.floor(math.log10(zoom))
    mantissa = zoom / 10**exponent
    if not unicode:
        return f"x{mantissa:.1f}e{exponent}"
    return f"×{mantissa:.1f}·10{str(exponent).translate(SUPERSCRIPT)}"


def stamp(frame: Image.Image, scale: float, start_scale: float) -> None:
    """Magnification in the bottom-left corner, on a translucent pill."""
    size = max(12, frame.height // 26)
    font, unicode = load_font(size)
    text = magnification_label(scale, start_scale, unicode)
    draw = ImageDraw.Draw(frame, "RGBA")
    pad, margin = size // 2, size // 2 + 4
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    x, y = margin, frame.height - margin - (bottom - top) - 2 * pad
    draw.rounded_rectangle(
        (x, y, x + (right - left) + 2 * pad, y + (bottom - top) + 2 * pad),
        radius=pad,
        fill=(10, 14, 28, 150),
    )
    draw.text((x + pad - left, y + pad - top), text, font=font, fill=(240, 244, 255, 255))


def render_cuda(args: argparse.Namespace, path: list[tuple[float, str, str, int]]) -> list[Image.Image]:
    if not os.path.exists(args.exe):
        sys.exit(f"{args.exe} not found: build the CUDA renderer first (see cuda/README.md)")
    frames = []
    with tempfile.TemporaryDirectory() as tmp:
        for k, (scale, re, im, max_iter) in enumerate(path):
            out = os.path.join(tmp, f"f{k:03d}.png")
            subprocess.run(
                [
                    args.exe,
                    "--w", str(args.width * args.ss),
                    "--h", str(args.height * args.ss),
                    "--iter", str(max_iter),
                    "--scale", f"{scale:.8e}",
                    "--re", re,
                    "--im", im,
                    "--cre", str(args.cre),
                    "--cim", str(args.cim),
                    "--out", out,
                ],
                check=True,
                stdout=subprocess.DEVNULL,
            )
            frames.append(Image.open(out).convert("RGB"))
            print(f"\rframe {k + 1}/{len(path)} (scale {scale:.1e}, iter {max_iter})", end="", flush=True)
    print()
    return frames


def main() -> None:
    p = argparse.ArgumentParser(description="Render the deep-zoom hero animation")
    p.add_argument("--exe", default=os.path.join("cuda", "julia.exe" if os.name == "nt" else "julia"))
    # The default target lies ON the Julia set: it was reached by 400 steps of
    # inverse iteration z -> ±sqrt(z - c) with random signs (seed 12), in
    # mpmath at 60 digits, and kept for the scenery along the way. A typical
    # point of J, unlike a fixed point, does not repeat itself as you zoom
    # (the β fixed point is an endpoint, half the frame stays empty; the α one
    # spins faster than the frame rate can show). A centre merely *near* the
    # set drifts off it and goes blank.
    p.add_argument(
        "--re", default="1.041429874783107853675907695758299219263",
        help="zoom target, real part (must lie on the Julia set)",
    )
    p.add_argument(
        "--im", default="-0.469586375520406689895032494407833922384",
        help="zoom target, imaginary part",
    )
    p.add_argument("--cre", type=float, default=-0.8)
    p.add_argument("--cim", type=float, default=0.156)
    p.add_argument("--start-scale", type=float, default=3.0)
    p.add_argument("--end-scale", type=float, default=3e-15)
    p.add_argument("--frames", type=int, default=220)
    p.add_argument("--hold-start", type=int, default=12, help="extra copies of the first frame")
    p.add_argument("--hold-end", type=int, default=30, help="extra copies of the last frame")
    p.add_argument("--width", type=int, default=800)
    p.add_argument("--height", type=int, default=450)
    p.add_argument("--colors", type=int, default=256, help="GIF only")
    p.add_argument("--quality", type=int, default=60, help="WebP only, 0-100")
    p.add_argument("--duration", type=int, default=40, help="ms per frame")
    p.add_argument("--ss", type=int, default=2, help="supersampling factor")
    p.add_argument(
        "--dither",
        choices=["none", "fs"],
        default="none",
        help="none: crisp + compresses ~2x better (256 colours hide the banding); "
        "fs: Floyd-Steinberg, whose per-frame noise shimmers in motion",
    )
    p.add_argument("--frames-dir", help="assemble pre-rendered frames instead of calling the CUDA renderer")
    p.add_argument("--print-path", action="store_true", help="print the camera path as CSV and exit")
    p.add_argument("--out", default=os.path.join("docs", "zoom.webp"), help=".webp (lossy) or .gif")
    args = p.parse_args()

    path = camera_path(args)
    if args.print_path:
        print("frame,scale,re,im,max_iter")
        for k, (scale, re, im, max_iter) in enumerate(path):
            print(f"{k},{scale:.17g},{re},{im},{max_iter}")
        return

    if args.frames_dir:
        files = sorted(
            f for f in glob.glob(os.path.join(args.frames_dir, "*"))
            if f.lower().endswith((".png", ".jpg", ".jpeg"))
        )
        if len(files) != len(path):
            sys.exit(f"{len(files)} frames in {args.frames_dir}, the path has {len(path)}")
        raw = [Image.open(f).convert("RGB") for f in files]
    else:
        raw = render_cuda(args, path)

    frames = []
    for image, (scale, *_rest) in zip(raw, path, strict=True):
        frame = image.resize((args.width, args.height), Image.LANCZOS)
        stamp(frame, scale, args.start_scale)
        frames.append(frame)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    if args.out.lower().endswith(".webp"):
        # Lossy animated WebP: full colour, and a fraction of the GIF's size on
        # this kind of fine, noisy detail.
        sequence = [frames[0]] * args.hold_start + frames + [frames[-1]] * args.hold_end
        sequence[0].save(
            args.out,
            save_all=True,
            append_images=sequence[1:],
            duration=args.duration,
            loop=0,
            quality=args.quality,
            method=6,
        )
    else:
        # One palette for the whole GIF, built from a mosaic of frames spread
        # over the zoom: the colours cycle with depth, so a single frame would
        # not cover them.
        picks = frames[:: max(1, len(frames) // 12)]
        tile_w, tile_h = args.width // 2, args.height // 2
        mosaic = Image.new("RGB", (tile_w * len(picks), tile_h))
        for i, frame in enumerate(picks):
            mosaic.paste(frame.resize((tile_w, tile_h), Image.LANCZOS), (i * tile_w, 0))
        reference = mosaic.quantize(colors=args.colors, method=Image.Quantize.MEDIANCUT)
        dither = Image.Dither.FLOYDSTEINBERG if args.dither == "fs" else Image.Dither.NONE
        quantized = [f.quantize(palette=reference, dither=dither) for f in frames]
        sequence = [quantized[0]] * args.hold_start + quantized + [quantized[-1]] * args.hold_end
        sequence[0].save(
            args.out,
            save_all=True,
            append_images=sequence[1:],
            duration=args.duration,
            loop=0,
            optimize=True,
        )
    size_mb = os.path.getsize(args.out) / 1e6
    seconds = len(sequence) * args.duration / 1000
    print(f"-> {args.out} ({size_mb:.2f} MB, {len(sequence)} frames, {seconds:.1f} s)")
    # GitHub's image proxy (camo) refuses files around 10 MB; stay well under.
    if size_mb > 8.5:
        print("Over the 8.5 MB budget: retry with fewer frames, a smaller size or a lower quality.")


if __name__ == "__main__":
    main()
