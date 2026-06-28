# FractalFlow

Interactive GPU-accelerated Julia set explorer built with TypeScript, WebGL2,
and GLSL. Python/`uv` tooling will provide reference renders, numerical
experiments, and reproducible benchmarks.

The implementation follows these milestones:
first a readable WebGL2 viewer, then interaction and measurement, and only
later optional WebGPU, CUDA, and deep-zoom backends.

## Repository layout

- `src/renderer/`: WebGL2 orchestration and shader compilation.
- `src/controls/`: mouse and keyboard input translated into view changes.
- `src/math/`: renderer-independent viewport and complex-plane calculations.
- `src/ui/`: lightweight overlays such as runtime statistics.
- `scripts/`: Python reference renders and offline benchmark analysis.
- `tests/`: automated checks added alongside stable behavior.
- `artifacts/`: generated images and benchmark results; ignored by Git.

The source files currently contain milestone-oriented placeholders. Each one
states its responsibility so implementation can remain incremental.

