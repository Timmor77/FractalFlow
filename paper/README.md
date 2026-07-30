# FractalFlow technical report

This directory contains the source, frozen measurements and generated figures
for:

> Timofei Amosov. *FractalFlow: Portable Deep-Zoom Julia Rendering with
> Perturbation Theory across WebGPU and CUDA*. Technical report, version 1.2.0,
> 2026.

Reserved report DOI: <https://doi.org/10.5281/zenodo.21686326>.

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

# Six independent mpmath-vs-CUDA validation cases, and the release gate.
# Compares colours and raw escape times (julia.exe --raw); the .f32 dumps are
# working files, the CSV is the artefact.
uv --cache-dir .uv-cache run python scripts/validate_release.py

# Where the pipeline stops agreeing (sets the camera floor, ~20 min)
uv --cache-dir .uv-cache run python scripts/validate_release.py --depth-sweep

# CUDA and CPU benchmark measurements
cuda/julia.exe --bench --w 1920 --h 1080 --out paper/data/benchmark/cuda_bench.csv
uv --cache-dir .uv-cache run python scripts/reference_julia.py --bench
Copy-Item artifacts/cpu_bench.csv paper/data/benchmark/cpu_bench.csv

# How much of the iteration cap the benchmark views actually use (~12 min).
# Section 6.2 uses this to correct the upper-bound GIter/s convention.
uv --cache-dir .uv-cache run python scripts/reference_julia.py --escape-stats

# Browser artefacts: start the app, then
#   /?bench=webgpu  -> save the CSV as paper/data/benchmark/webgpu_bench.csv
#   /?validate      -> save the CSV as data/validation/webgpu_validation.csv
npm run dev

# Regenerate every report figure and the LaTeX data tables
uv --cache-dir .uv-cache run python paper/generate_figures.py
```

`generate_figures.py` writes its PDFs without an embedded creation date, so a
re-run on unchanged inputs reproduces the hashes recorded in
`generated/manifest.json` byte for byte. A hash mismatch means the data
changed, not that the plot was redrawn.

Both browser pages write a machine-readable record to the developer console
(`FRACTALFLOW_BENCH_RESULTS`, `FRACTALFLOW_VALIDATION_RESULTS`) in addition to
their download button. Keep the CSV header lines: they record the adapter,
browser, resolution, warm-up count and timing method, which is the only thing
tying a number to the machine that produced it.

`data/validation/depth_sweep.csv` is a measurement, not a gate — it is what
sets the `1e-20` camera floor in `src/core/config.ts`. If it is ever re-run
with a different result, that constant moves with it.

`data/validation/below_binary64_absolute.png` is the middle panel of Figure 3:
the same view rendered by the kernel *before* the reference orbit was stored
relative to Z0. It is the one archived image the current source cannot
reproduce, so here is how it was made:

```powershell
git show 1677d79:cuda/julia.cu > $env:TEMP\julia_absolute.cu
nvcc -O3 $env:TEMP\julia_absolute.cu -o $env:TEMP\julia_absolute.exe
& $env:TEMP\julia_absolute.exe --w 64 --h 64 --iter 700 --scale 1e-16 `
    --re -0.527503118643534632274607931351916169475312417511732493905728256658568636526 `
    --im 0.0759121783522878653764568658687429427997344025257309526545062431394591595504 `
    --cre -0.8 --cim 0.156 --out paper/data/validation/below_binary64_absolute.png
```

## Build the PDF

```powershell
latexmk -cd -norc -pdf -file-line-error -halt-on-error -interaction=nonstopmode paper/main.tex
```

The GitHub workflow uses TeX Live 2026 and uploads `paper/main.pdf` as a build
artifact. The archival copy is not published until the values in the text,
tables and figures agree with the frozen CSV files and both Zenodo identifiers
have been inserted.
