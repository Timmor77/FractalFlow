# Changelog

Notable changes to FractalFlow. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **Tiled export up to 16K.** The PNG export renders 512-pixel tiles and feeds
  them to a streaming PNG encoder (`src/export/`), so no single draw call is
  long enough to trip a GPU watchdog and the picture is never held whole in
  memory. The size is no longer bounded by the GPU's largest texture: 16K
  (15360×8640) is twice the 8192 limit of a default WebGPU device. A tiled
  export is pixel-identical to a single-draw one on both backends. The panel
  offers 4K / 8K / 16K, shows progress, and the export can be cancelled
  (button or `Esc`).
- **WebGPU validation on raw escape times.** The shader has a second output
  (`fsRaw`) that writes the smooth iteration count to a float target, the
  mpmath references archive theirs (`*_reference.f32`), and `/?validate`
  compares the two with a PASS/FAIL verdict per case. Colours are still
  reported, as a secondary figure.
- `scripts/validate_release.py --reference-raw`: regenerates the references'
  raw escape times with mpmath alone (no CUDA binary), checking each against
  its archived PNG.
- Keyboard navigation: arrows pan, `+` / `-` zoom.
- A visible message when the GPU device is lost or no backend can start,
  instead of a frozen or black page.
- `paper/generate_figures.py --check`: verifies the archived report data
  against its manifest without regenerating anything. Run in CI.
- ESLint (type-aware), Prettier and ruff, enforced in CI; `npm run check` runs
  everything locally.

### Changed

- README visuals. The hero animation (`docs/zoom.avif`, replacing
  `docs/zoom.gif`) now goes from the whole set to ×10¹⁵, past the `float64`
  limit, with a magnification counter. Its target is a typical point of the
  Julia set instead of the β fixed point, which kept half the frame empty. It
  was rendered by the WebGPU backend at 4800×2700 per frame, averaged 3×3 in
  linear light to 1600×900 and shown at half size, so it stays sharp on
  high-density screens. It is an AVIF with every frame a keyframe: Safari
  played the same animation as a WebP at about 1.4 frames per second, and as an
  inter-coded AVIF at about 3; this one plays at 25 in Safari and Chrome. The
  pauses at both ends are frame durations rather than copies of the frame,
  which takes the file from 46.8 to 41.4 MB with the same 220 frames, bit for
  bit; Safari shows nothing until the whole file has arrived, so its wait
  shrinks in proportion. `scripts/make_zoom_gif.py` gains the new camera path, linear-light
  downsampling, `--frames-dir`, `--print-path` and AVIF (via ffmpeg and
  SVT-AV1) and WebP output. The stills are now lossless PNG at two to three
  times their displayed size (the JPEGs' chroma subsampling smeared the fine
  colour detail): the gallery is reframed on each set's spiralling fixed point,
  the deep-zoom figure is the spiral around the α fixed point at `3e-14`, and
  the app screenshot is retaken at 2×.
- The README's benchmark charts are redrawn from the frozen 1.2.0 data in
  `paper/data/benchmark/`. They had been plotted from an earlier run and showed
  a WebGPU peak near 900 GIter/s, against the 1 168 the text and the report
  cite. `scripts/benchmark.py` now draws them at 2× on a transparent
  background, in colours that keep their contrast on GitHub's light and dark
  themes.
- The WGSL iteration reads the reference orbit once per iteration instead of
  twice (the value fetched for the rebasing test is carried to the next
  iteration). Output is bit-identical; frame time dropped by about 10% at the
  deep end of the benchmark schedule on an Apple M5 Pro. The RTX 3060 Ti
  figures in the README and the report are from 1.2.0 and were not re-measured.
- The palette lookup table is sampled at texel centres. It used to be half a
  texel off the analytic gradient of the CUDA and Python renderers (about one
  8-bit level on average).
- The interaction resolution follows the display's refresh interval. On a
  60 Hz display it could previously be lowered but never raised again.
- `main.ts` is split into modules: render loop (`core/frameLoop.ts`), URL state
  (`core/urlState.ts`), export (`export/`), toast and error UI.
- Text files are stored and checked out with LF (`.gitattributes`), and the
  report manifest hashes them that way: it now matches on every clone, not
  only on the Windows machine that produced it.
- `validate_release.py --case` writes `validation_results_partial.csv` instead
  of truncating the frozen matrix.

### Fixed

- The WebGL2 fallback could not start after a WebGPU failure that happened
  once the canvas had been bound to WebGPU.
- A shared link without `c` or palette loaded `c = 0` and the first palette
  instead of keeping the current ones.
- The CUDA renderer reported success when it could not write its PNG or CSV.

## 1.2.0 — 2026-07-30

Escape-time validation of the CUDA backend, the orbit-encoding figure, the 4K
plate, and the technical report at its current evidence. See the
[report](paper/main.pdf).
