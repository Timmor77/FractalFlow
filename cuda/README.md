# FractalFlow — CUDA backend

Native deep-zoom Julia renderer + throughput benchmark. Same perturbation algorithm
as the WebGPU backend (`src/backends/webgpu/julia.wgsl`), but with a `double`-precision
delta iteration and a double-double reference orbit computed on the host.

- `julia.cu` — renderer, benchmark, and host double-double math (single file).
- `stb_image_write.h` — vendored public-domain PNG writer ([nothings/stb](https://github.com/nothings/stb)).

## Build

Requires the CUDA Toolkit (`nvcc`) and a host C++ compiler.

```bash
nvcc -O3 julia.cu -o julia
```

**Windows note:** `nvcc` needs MSVC's `cl.exe` on the `PATH`. Run the build from a
*Developer Command Prompt*, or initialise the environment first:

```bat
"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
nvcc -O3 julia.cu -o julia.exe
```

## Usage

```bash
# Full view -> PNG
./julia --w 1600 --h 1600 --iter 500 --scale 3 --out ../artifacts/cuda.png

# Deep zoom. --re / --im accept high-precision decimal strings (parsed to double-double).
./julia --re 0.0304 --im -0.564 --scale 6e-3 --iter 2500 --out ../artifacts/zoom.png

# Throughput benchmark across zoom depths -> CSV (plot it with scripts/benchmark.py)
./julia --bench --w 1920 --h 1080 --out ../artifacts/cuda_bench.csv
```

| Flag | Meaning | Default |
|------|---------|---------|
| `--re`, `--im` | view centre (decimal strings) | `0`, `0` |
| `--scale` | view height in the complex plane | `3.0` |
| `--cre`, `--cim` | Julia parameter `c` | `-0.8`, `0.156` |
| `--w`, `--h` | resolution | `1600×1600` (render) |
| `--iter` | max iterations | `500` |
| `--out` | output path (`.png`, or `.csv` for `--bench`) | `../artifacts/…` |
| `--bench` | benchmark mode | off |

## Validation

Cross-checked pixel-for-pixel against the Python `mpmath` reference — see
`scripts/reference_julia.py` and the *Correctness* section of the top-level README.
