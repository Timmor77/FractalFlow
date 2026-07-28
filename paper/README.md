# FractalFlow technical report

This directory contains the source, frozen measurements and generated figures
for:

> Timofei Amosov. *FractalFlow: Portable Deep-Zoom Julia Rendering with
> Perturbation Theory across WebGPU and CUDA*. Technical report, version 1.1.0,
> 2026.

The report is CC BY 4.0. The software in the parent repository is Apache-2.0.

## Reproduce the evidence

From the repository root:

```powershell
# JavaScript math-core tests and production build
npm ci
npm test
npm run build

# Native CUDA renderer
nvcc -O3 cuda/julia.cu -o cuda/julia.exe

# Four independent mpmath-vs-CUDA validation cases
uv --cache-dir .uv-cache run python scripts/validate_release.py

# CUDA and CPU benchmark measurements
cuda/julia.exe --bench --w 1920 --h 1080 --out paper/data/benchmark/cuda_bench.csv
uv --cache-dir .uv-cache run python scripts/reference_julia.py --bench
Copy-Item artifacts/cpu_bench.csv paper/data/benchmark/cpu_bench.csv

# WebGPU: start the app, open /?bench=webgpu, and save the emitted CSV as
# paper/data/benchmark/webgpu_bench.csv.
npm run dev

# Regenerate every report figure and the LaTeX data tables
uv --cache-dir .uv-cache run python paper/generate_figures.py
```

The browser benchmark writes a machine-readable
`FRACTALFLOW_BENCH_RESULTS` record to the developer console in addition to the
download button. Keep the CSV header lines because they record the adapter,
browser, resolution, warm-up count and timing method.

## Build the PDF

```powershell
latexmk -cd -norc -pdf -file-line-error -halt-on-error -interaction=nonstopmode paper/main.tex
```

The GitHub workflow uses TeX Live 2026 and uploads `paper/main.pdf` as a build
artifact. The archival copy is not published until the values in the text,
tables and figures agree with the frozen CSV files and both Zenodo identifiers
have been inserted.
