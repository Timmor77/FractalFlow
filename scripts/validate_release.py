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
    return {
        "mean_abs_rgb": float(diff.mean()),
        "max_abs_rgb": int(diff.max()),
        "identical_pixels_pct": float((per_pixel_max == 0).mean() * 100.0),
        "matching_pixels_le4_pct": float((per_pixel_max <= 4).mean() * 100.0),
    }


def render_case(case: dict[str, object], cuda_exe: Path, out_dir: Path) -> dict[str, object]:
    case_id = str(case["id"])
    reference_path = out_dir / f"{case_id}_reference.png"
    cuda_path = out_dir / f"{case_id}_cuda.png"
    width = int(case["width"])
    height = int(case["height"])
    max_iter = int(case["max_iter"])

    center_re_dd = dd_from_decimal(str(case["center_re"]))
    center_im_dd = dd_from_decimal(str(case["center_im"]))
    reference = render_mpmath(
        center_re_dd,
        center_im_dd,
        float(case["scale"]),
        float(case["c_re"]),
        float(case["c_im"]),
        max_iter,
        width,
        height,
        int(case["dps"]),
        binary64_pixels=True,
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
    ]
    subprocess.run(command, cwd=ROOT, check=True)

    metrics = compare_images(reference_path, cuda_path)
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
    args = parser.parse_args()

    cuda_exe = args.cuda.resolve()
    if not cuda_exe.exists():
        raise SystemExit(
            f"CUDA renderer not found: {cuda_exe}. Compile it with "
            "nvcc -O3 cuda/julia.cu -o cuda/julia.exe"
        )

    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    selected = set(args.case)
    if selected:
        known = {str(case["id"]) for case in cases}
        unknown = selected - known
        if unknown:
            raise SystemExit(f"unknown validation case(s): {sorted(unknown)}")
        cases = [case for case in cases if str(case["id"]) in selected]

    args.out.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, object]] = []
    for case in cases:
        print(f"[{case['id']}] rendering mpmath reference and CUDA candidate")
        row = render_case(case, cuda_exe, args.out)
        rows.append(row)
        print(
            f"  mean={row['mean_abs_rgb']:.6f}/255, "
            f"max={row['max_abs_rgb']}/255, "
            f"identical={row['identical_pixels_pct']:.2f}%, "
            f"within4={row['matching_pixels_le4_pct']:.2f}%"
        )

    csv_path = args.out / "validation_results.csv"
    fieldnames = list(rows[0])
    with csv_path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"validation matrix -> {csv_path}")

    if any(float(row["mean_abs_rgb"]) >= 3.0 for row in rows):
        print("ERROR: at least one case exceeds the documented mean RGB threshold")
        sys.exit(1)


if __name__ == "__main__":
    main()
