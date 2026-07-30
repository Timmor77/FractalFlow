"""Reproduce the fixed mpmath-vs-CUDA validation matrix for the report.

The renderer under test uses perturbation. The reference deliberately does
not: it performs direct arbitrary-precision iteration through
``reference_julia.render_mpmath``. The output CSV is the source of truth for
the validation table in ``paper/main.tex``.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from reference_julia import render_mpmath


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASES = ROOT / "paper" / "data" / "validation_cases.json"
DEFAULT_OUT = ROOT / "paper" / "data" / "validation"


def two_sum(a: float, b: float) -> tuple[float, float]:
    total = a + b
    bb = total - a
    return total, (a - (total - bb)) + (b - bb)


def quick_two_sum(a: float, b: float) -> tuple[float, float]:
    total = a + b
    return total, b - (total - a)


def two_prod(a: float, b: float) -> tuple[float, float]:
    product = a * b
    ca = 134217729.0 * a
    a_hi = ca - (ca - a)
    a_lo = a - a_hi
    cb = 134217729.0 * b
    b_hi = cb - (cb - b)
    b_lo = b - b_hi
    error = (
        ((a_hi * b_hi - product) + a_hi * b_lo + a_lo * b_hi) + a_lo * b_lo
    )
    return product, error


def dd_add(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    total, error = two_sum(a[0], b[0])
    return quick_two_sum(total, error + a[1] + b[1])


def dd_mul(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    product, error = two_prod(a[0], b[0])
    return quick_two_sum(product, error + (a[0] * b[1] + a[1] * b[0]))


def dd_div(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    q1 = a[0] / b[0]
    product = dd_mul(b, (q1, 0.0))
    remainder = dd_add(a, (-product[0], -product[1]))
    q2 = remainder[0] / b[0]
    product = dd_mul(b, (q2, 0.0))
    remainder = dd_add(remainder, (-product[0], -product[1]))
    q3 = remainder[0] / b[0]
    quotient = quick_two_sum(q1, q2)
    return dd_add(quotient, (q3, 0.0))


def dd_from_decimal(text: str) -> tuple[float, float]:
    """Mirror cuda/julia.cu's decimal-to-DD parser for candidate coordinates."""
    stripped = text.strip()
    negative = stripped.startswith("-")
    if stripped[:1] in {"+", "-"}:
        stripped = stripped[1:]

    value = (0.0, 0.0)
    fractional_digits = 0
    in_fraction = False
    for character in stripped:
        if character == ".":
            in_fraction = True
            continue
        if not character.isdigit():
            break
        value = dd_add(dd_mul(value, (10.0, 0.0)), (float(character), 0.0))
        if in_fraction:
            fractional_digits += 1

    ten_power = (1.0, 0.0)
    for _ in range(fractional_digits):
        ten_power = dd_mul(ten_power, (10.0, 0.0))
    value = dd_div(value, ten_power)
    if negative:
        value = (-value[0], -value[1])
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def compare_images(reference_path: Path, candidate_path: Path) -> dict[str, float]:
    reference = np.asarray(Image.open(reference_path).convert("RGB"), dtype=np.int16)
    candidate = np.asarray(Image.open(candidate_path).convert("RGB"), dtype=np.int16)
    if reference.shape != candidate.shape:
        raise ValueError(
            f"shape mismatch: reference {reference.shape}, candidate {candidate.shape}"
        )

    diff = np.abs(candidate - reference)
    per_pixel_max = diff.max(axis=2)
    # Interior pixels are painted pure black by every backend, so a pixel that is
    # black on one side and coloured on the other is an escaped/not-escaped
    # disagreement rather than a colour rounding difference. It is the one error
    # a mean cannot see, and the one that matters most.
    interior_reference = (reference == 0).all(axis=2)
    interior_candidate = (candidate == 0).all(axis=2)
    return {
        "mean_abs_rgb": float(diff.mean()),
        "max_abs_rgb": int(diff.max()),
        "identical_pixels_pct": float((per_pixel_max == 0).mean() * 100.0),
        "matching_pixels_le4_pct": float((per_pixel_max <= 4).mean() * 100.0),
        "interior_flips_pct": float((interior_reference != interior_candidate).mean() * 100.0),
    }


# Escape-time comparison, free of the palette.
#
# Colours are a lossy view of the iteration state: two different escape times
# can land on the same 8-bit colour, and the browser's palette lookup table
# shifts most pixels by a level or two for reasons that have nothing to do with
# arithmetic. The renderers therefore also emit the smooth iteration count
# itself, and this compares that. Tolerance is far above the f32 noise floor
# (~1e-4 at these counts) and far below one iteration.
RAW_TOLERANCE = 0.01


def compare_raw(reference: np.ndarray, candidate: np.ndarray) -> dict[str, float]:
    interior_reference = reference < 0.0
    interior_candidate = candidate < 0.0
    both_escaped = ~interior_reference & ~interior_candidate
    difference = np.abs(candidate - reference)[both_escaped]
    return {
        "raw_max_abs_iter": float(difference.max()) if difference.size else 0.0,
        "raw_over_tolerance_pct": float(
            (difference > RAW_TOLERANCE).sum() / reference.size * 100.0
        ),
        "raw_interior_flips_pct": float(
            (interior_reference != interior_candidate).mean() * 100.0
        ),
    }


def render_case(case: dict[str, object], cuda_exe: Path, out_dir: Path) -> dict[str, object]:
    case_id = str(case["id"])
    reference_path = out_dir / f"{case_id}_reference.png"
    cuda_path = out_dir / f"{case_id}_cuda.png"
    raw_path = out_dir / f"{case_id}_cuda.f32"
    width = int(case["width"])
    height = int(case["height"])
    max_iter = int(case["max_iter"])

    center_re_dd = dd_from_decimal(str(case["center_re"]))
    center_im_dd = dd_from_decimal(str(case["center_im"]))
    reference, reference_raw = render_mpmath(
        center_re_dd,
        center_im_dd,
        float(case["scale"]),
        float(case["c_re"]),
        float(case["c_im"]),
        max_iter,
        width,
        height,
        int(case["dps"]),
        with_raw=True,
    )
    Image.fromarray(reference).save(reference_path)

    command = [
        str(cuda_exe),
        "--w",
        str(width),
        "--h",
        str(height),
        "--iter",
        str(max_iter),
        "--scale",
        str(case["scale"]),
        "--re",
        str(case["center_re"]),
        "--im",
        str(case["center_im"]),
        "--cre",
        str(case["c_re"]),
        "--cim",
        str(case["c_im"]),
        "--out",
        str(cuda_path),
        "--raw",
        str(raw_path),
    ]
    subprocess.run(command, cwd=ROOT, check=True)

    candidate_raw = np.fromfile(raw_path, dtype=np.float32).reshape(height, width)
    metrics = compare_images(reference_path, cuda_path)
    metrics.update(compare_raw(reference_raw, candidate_raw))
    return {
        **case,
        **metrics,
        "center_re_hi": center_re_dd[0],
        "center_re_lo": center_re_dd[1],
        "center_im_hi": center_im_dd[0],
        "center_im_lo": center_im_dd[1],
        "reference_file": reference_path.name,
        "candidate_file": cuda_path.name,
        "reference_sha256": sha256(reference_path),
        "candidate_sha256": sha256(cuda_path),
    }


# Release gate. A mean alone is far too forgiving on a 4096-pixel image: a
# handful of completely wrong pixels barely moves it. These three thresholds
# each catch a different failure — a global colour shift, a scattering of wrong
# pixels, and escaped/not-escaped flips, which are the ones a broken rebasing
# step produces.
MAX_MEAN_ABS_RGB = 3.0
MAX_WORSE_THAN_4_PCT = 1.0
MAX_INTERIOR_FLIPS_PCT = 0.5
MAX_RAW_OVER_TOLERANCE_PCT = 1.0


def check_thresholds(rows: list[dict[str, object]]) -> list[str]:
    failures: list[str] = []
    for row in rows:
        case = row["id"]
        mean = float(row["mean_abs_rgb"])
        worse_than_four = 100.0 - float(row["matching_pixels_le4_pct"])
        flips = float(row["interior_flips_pct"])
        if mean >= MAX_MEAN_ABS_RGB:
            failures.append(f"{case}: mean {mean:.3f} >= {MAX_MEAN_ABS_RGB} RGB levels")
        if worse_than_four > MAX_WORSE_THAN_4_PCT:
            failures.append(
                f"{case}: {worse_than_four:.2f}% of pixels differ by more than 4 levels "
                f"(limit {MAX_WORSE_THAN_4_PCT}%)"
            )
        if flips > MAX_INTERIOR_FLIPS_PCT:
            failures.append(
                f"{case}: {flips:.2f}% interior/exterior flips "
                f"(limit {MAX_INTERIOR_FLIPS_PCT}%)"
            )
        raw_off = float(row["raw_over_tolerance_pct"])
        if raw_off > MAX_RAW_OVER_TOLERANCE_PCT:
            failures.append(
                f"{case}: {raw_off:.2f}% of escape times differ by more than "
                f"{RAW_TOLERANCE} iterations (limit {MAX_RAW_OVER_TOLERANCE_PCT}%)"
            )
    return failures


def run_depth_sweep(cases: list[dict[str, object]], cuda_exe: Path, out_dir: Path) -> None:
    """Render the fixed-point case at increasing depth to find where it breaks.

    This is a measurement, not a gate: it is what sets the camera's zoom floor.
    The reference orbit is double-double (~32 digits), so it eventually stops
    resolving the pixel grid; the sweep says where.
    """
    template = next(case for case in cases if case["id"] == "fixed_point")
    # The per-scale renders are working images, not release evidence: keep them
    # out of the archived directory and let the CSV be the artifact.
    render_dir = out_dir / "sweep"
    render_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, object]] = []
    for exponent in (16, 20, 24, 28):
        case = dict(template)
        case["id"] = f"sweep_1e-{exponent}"
        case["label"] = f"Fixed point, 1e-{exponent}"
        case["scale"] = 10.0**-exponent
        case["max_iter"] = 1200
        case["dps"] = 90
        row = render_case(case, cuda_exe, render_dir)
        rows.append(
            {
                "scale": f"{float(case['scale']):.0e}",
                "max_iter": case["max_iter"],
                "dps": case["dps"],
                "mean_abs_rgb": f"{float(row['mean_abs_rgb']):.6f}",
                "max_abs_rgb": row["max_abs_rgb"],
                "identical_pixels_pct": f"{float(row['identical_pixels_pct']):.4f}",
                "matching_pixels_le4_pct": f"{float(row['matching_pixels_le4_pct']):.4f}",
                "interior_flips_pct": f"{float(row['interior_flips_pct']):.4f}",
            }
        )
        print(f"  1e-{exponent}: mean={row['mean_abs_rgb']:.6f}, max={row['max_abs_rgb']}, "
              f"identical={row['identical_pixels_pct']:.2f}%")

    csv_path = out_dir / "depth_sweep.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"depth sweep -> {csv_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate the CUDA perturbation renderer against mpmath"
    )
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--cuda", type=Path, default=ROOT / "cuda" / "julia.exe")
    parser.add_argument(
        "--case",
        action="append",
        default=[],
        help="case id to run; repeat to select several (default: all)",
    )
    parser.add_argument(
        "--depth-sweep",
        action="store_true",
        help="instead of the release matrix, sweep the fixed-point case from 1e-16 to "
        "1e-28 to locate the camera's usable floor (slow: mpmath at 1200 iterations)",
    )
    args = parser.parse_args()

    cuda_exe = args.cuda.resolve()
    if not cuda_exe.exists():
        raise SystemExit(
            f"CUDA renderer not found: {cuda_exe}. Compile it with "
            "nvcc -O3 cuda/julia.cu -o cuda/julia.exe"
        )

    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    args.out.mkdir(parents=True, exist_ok=True)

    if args.depth_sweep:
        run_depth_sweep(cases, cuda_exe, args.out)
        return

    selected = set(args.case)
    if selected:
        known = {str(case["id"]) for case in cases}
        unknown = selected - known
        if unknown:
            raise SystemExit(f"unknown validation case(s): {sorted(unknown)}")
        cases = [case for case in cases if str(case["id"]) in selected]

    rows: list[dict[str, object]] = []
    for case in cases:
        print(f"[{case['id']}] rendering mpmath reference and CUDA candidate")
        row = render_case(case, cuda_exe, args.out)
        rows.append(row)
        print(
            f"  mean={row['mean_abs_rgb']:.6f}/255, "
            f"max={row['max_abs_rgb']}/255, "
            f"identical={row['identical_pixels_pct']:.2f}%, "
            f"within4={row['matching_pixels_le4_pct']:.2f}%, "
            f"escape times off by >{RAW_TOLERANCE}: "
            f"{row['raw_over_tolerance_pct']:.2f}% (max {row['raw_max_abs_iter']:.3f} iter)"
        )

    csv_path = args.out / "validation_results.csv"
    fieldnames = list(rows[0])
    with csv_path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"validation matrix -> {csv_path}")

    failures = check_thresholds(rows)
    for failure in failures:
        print(f"ERROR: {failure}")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
