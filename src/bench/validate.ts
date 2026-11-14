// In-browser validation harness, opened via `/?validate` (see main.ts).
//
// The frozen release matrix (paper/data/validation) is produced by CUDA against
// an arbitrary-precision mpmath reference. It says nothing about the browser,
// whose per-pixel deltas are f32 rather than f64. This harness closes that gap:
// it renders the same cases with the WebGPU backend, at the same size, from the
// same double-double centres, and compares them with the same references.
//
// What is compared is the ESCAPE TIME, not the colour. The shader has a second
// output (fsRaw in julia.wgsl) that writes the smooth iteration count of every
// pixel to a float target, and the reference archives its own counts next to
// each PNG (<case>_reference.f32). Colours are a lossy, palette-dependent view
// of that number: comparing them mixes arithmetic with 8-bit rounding and
// lookup-table sampling. The RGB difference is still reported, as a secondary
// line, because it is what a viewer actually sees.
//
// Each case gets a verdict against the thresholds below. Results are logged
// as FRACTALFLOW_VALIDATION_RESULTS and offered as a CSV download.

import type { ViewState } from "../core/types";
import { WebGPURenderer } from "../backends/webgpu/webgpuRenderer";
import { PALETTES, DEFAULT_PALETTE, buildPaletteLut } from "../ui/palettes";
import { createReportPage, describeAdapter } from "./page";

// The archived matrix, served from the repository by the dev server. It is not
// part of the production build, so this page only works from a clone.
const REFERENCE_DIR = `${import.meta.env.BASE_URL}paper/data/validation/`;
const RESULTS_CSV = `${REFERENCE_DIR}validation_results.csv`;

// Sentinel for "never escaped" in every raw grid (shader, CUDA, Python).
const INTERIOR = -1;

// --- Verdict ---
//
// An f32 orbit and an arbitrary-precision one cannot agree everywhere: near
// the Julia set the map is chaotic, a rounding error of 6e-8 doubles every
// iteration or so, and a pixel that takes hundreds of iterations to escape has
// forgotten its low bits long before. So the escape times split into a bulk
// that agrees to a fraction of an iteration and a tail that does not, and the
// gate tests each for what it can tell:
//
//   - the MEDIAN error catches anything systematic. An off-by-one in the
//     iteration count, a wrong escape radius or a shifted pixel grid moves
//     every pixel, hence the median, by about one iteration; chaos does not
//     touch it. Measured: at most 5e-4 iterations.
//   - the share of pixels more than ONE iteration off bounds the chaotic tail.
//     A broken rebasing step puts most of the image there. Measured: at most
//     about 10%, in the two cases that sit on the boundary at high iteration
//     counts.
//   - interior/exterior flips are counted apart: there the two renderers do
//     not even agree on whether the point escapes. Measured: at most 2%.
//
// The limits leave room above what was measured for another GPU's rounding
// (fused multiply-add contraction differs between drivers); they are a
// regression gate, not a claim that f32 is exact.
const MAX_MEDIAN_ABS_ITER = 0.01;
const MAX_OFF_BY_ONE_PCT = 15;
const MAX_INTERIOR_FLIPS_PCT = 3;

// Same tolerance as the CUDA gate (scripts/validate_release.py), reported for
// comparison with the f64 backend; f32 is not held to it.
const RAW_TOLERANCE = 0.01;

type Row = Record<string, string>;

type CaseMetrics = {
  id: string;
  scale: number;
  maxIter: number;
  pixels: number;
  // Escape times.
  interiorFlips: number;
  overTolerance: number;
  offByOne: number;
  medianAbsIter: number;
  maxAbsIter: number;
  // Colours.
  meanAbsRgb: number;
  maxAbsRgb: number;
  differingPixels: number;
  worseThan4: number;
  pass: boolean;
};

function parseCsv(text: string): Row[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((name, i): [string, string] => [name, cells[i]]));
  });
}

// fetch() resolves on a 404 too; and a dev server answers unknown paths with
// its index page. Either would otherwise be parsed as data.
async function fetchData(url: string): Promise<Response> {
  const response = await fetch(url);
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || type.includes("text/html")) {
    throw new Error(
      `Validation data not found at ${url}. It lives in the repository, not in the ` +
        "deployed site: clone it, run `npm run dev` and open /?validate there.",
    );
  }
  return response;
}

async function loadReferenceRaw(id: string, pixels: number): Promise<Float32Array> {
  const buffer = await (await fetchData(`${REFERENCE_DIR}${id}_reference.f32`)).arrayBuffer();
  if (buffer.byteLength !== pixels * 4) {
    throw new Error(
      `${id}_reference.f32 holds ${buffer.byteLength / 4} values, expected ${pixels}`,
    );
  }
  // Little-endian float32, as written by numpy ("<f4"); every platform WebGPU
  // runs on is little-endian.
  return new Float32Array(buffer);
}

async function loadReferenceRgba(
  file: string,
  width: number,
  height: number,
): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(await (await fetchData(REFERENCE_DIR + file)).blob());
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2D context unavailable for reference decoding");
  }
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, width, height).data;
}

function compareRaw(candidate: Float32Array, reference: Float32Array) {
  let interiorFlips = 0;
  let overTolerance = 0;
  let offByOne = 0;
  let maxAbs = 0;
  const differences: number[] = [];
  for (let p = 0; p < reference.length; p++) {
    const candidateInterior = candidate[p] === INTERIOR;
    const referenceInterior = reference[p] === INTERIOR;
    if (candidateInterior !== referenceInterior) {
      interiorFlips++;
      continue;
    }
    if (referenceInterior) {
      continue;
    }
    const difference = Math.abs(candidate[p] - reference[p]);
    differences.push(difference);
    if (difference > RAW_TOLERANCE) overTolerance++;
    if (difference > 1) offByOne++;
    maxAbs = Math.max(maxAbs, difference);
  }
  differences.sort((a, b) => a - b);
  const median = differences.length > 0 ? differences[differences.length >> 1] : 0;
  return { interiorFlips, overTolerance, offByOne, medianAbsIter: median, maxAbsIter: maxAbs };
}

// Both arrays are RGBA; alpha is ignored.
function compareRgb(candidate: Uint8Array, reference: Uint8ClampedArray, pixels: number) {
  let sum = 0;
  let max = 0;
  let differing = 0;
  let worseThan4 = 0;
  for (let p = 0; p < pixels; p++) {
    let pixelMax = 0;
    for (let k = 0; k < 3; k++) {
      const delta = Math.abs(candidate[p * 4 + k] - reference[p * 4 + k]);
      sum += delta;
      pixelMax = Math.max(pixelMax, delta);
    }
    max = Math.max(max, pixelMax);
    if (pixelMax > 0) differing++;
    if (pixelMax > 4) worseThan4++;
  }
  return { meanAbsRgb: sum / (pixels * 3), maxAbsRgb: max, differingPixels: differing, worseThan4 };
}

const percent = (count: number, total: number): number => (100 * count) / total;

export async function runValidation(): Promise<void> {
  const page = createReportPage(
    "WebGPU validation",
    "f32 perturbation shader vs the archived arbitrary-precision references",
  );

  let rows: Row[];
  try {
    rows = parseCsv(await (await fetchData(RESULTS_CSV)).text());
  } catch (error) {
    page.log(error instanceof Error ? error.message : String(error));
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  canvas.style.cssText = "position:fixed;left:-9999px";
  document.body.appendChild(canvas);
  const renderer = await WebGPURenderer.create(canvas);
  const adapter = await describeAdapter();
  const lut = buildPaletteLut(PALETTES[DEFAULT_PALETTE]);

  page.log(`adapter: ${adapter}`);
  page.log(
    `gate:    median |Δ| ≤ ${MAX_MEDIAN_ABS_ITER} iter, more than 1 iter off ≤ ${MAX_OFF_BY_ONE_PCT}%, ` +
      `interior flips ≤ ${MAX_INTERIOR_FLIPS_PCT}%`,
  );
  page.log("");
  page.log(
    `${"case".padEnd(18)} ${"scale".padStart(6)}  ${"flips".padStart(6)} ${">0.01".padStart(6)} ` +
      `${">1 iter".padStart(7)} ${"median".padStart(8)} ${"max".padStart(7)}  ${"RGB mean".padStart(8)}  verdict`,
  );

  const metrics: CaseMetrics[] = [];
  for (const row of rows) {
    const width = Number(row.width);
    const height = Number(row.height);
    const pixels = width * height;
    const view: ViewState = {
      centerX: { hi: Number(row.center_re_hi), lo: Number(row.center_re_lo) },
      centerY: { hi: Number(row.center_im_hi), lo: Number(row.center_im_lo) },
      scale: Number(row.scale),
      cx: Number(row.c_re),
      cy: Number(row.c_im),
      maxIter: Number(row.max_iter),
      paletteLut: lut,
    };

    const raw = compareRaw(
      await renderer.renderRaw(view, width, height),
      await loadReferenceRaw(row.id, pixels),
    );
    const rgb = compareRgb(
      await renderer.renderTile(view, { width, height }, { x: 0, y: 0, width, height }),
      await loadReferenceRgba(row.reference_file, width, height),
      pixels,
    );

    const pass =
      raw.medianAbsIter <= MAX_MEDIAN_ABS_ITER &&
      percent(raw.offByOne, pixels) <= MAX_OFF_BY_ONE_PCT &&
      percent(raw.interiorFlips, pixels) <= MAX_INTERIOR_FLIPS_PCT;

    metrics.push({
      id: row.id,
      scale: view.scale,
      maxIter: view.maxIter,
      pixels,
      ...raw,
      ...rgb,
      pass,
    });

    page.log(
      `${row.id.padEnd(18)} ${view.scale.toExponential(0).padStart(6)}  ` +
        `${percent(raw.interiorFlips, pixels).toFixed(2).padStart(5)}% ` +
        `${percent(raw.overTolerance, pixels).toFixed(2).padStart(5)}% ` +
        `${percent(raw.offByOne, pixels).toFixed(2).padStart(6)}% ` +
        `${raw.medianAbsIter.toExponential(1).padStart(8)} ` +
        `${raw.maxAbsIter.toFixed(1).padStart(7)}  ` +
        `${rgb.meanAbsRgb.toFixed(3).padStart(8)}  ${pass ? "PASS" : "FAIL"}`,
    );
  }
  canvas.remove();

  const allPass = metrics.every((m) => m.pass);
  page.log("");
  page.log(allPass ? `PASS — ${metrics.length} cases` : "FAIL — see the cases above");
  page.log("");
  page.log("flips, >0.01 and >1 iter are shares of the image; median and max are in iterations.");
  page.log("RGB mean is the colour difference in 8-bit levels (palette included), for reference.");

  const record = {
    backend: "WebGPU",
    adapter,
    browser: navigator.userAgent,
    pass: allPass,
    cases: metrics,
  };
  console.log("FRACTALFLOW_VALIDATION_RESULTS " + JSON.stringify(record));
  Object.assign(window, { FRACTALFLOW_VALIDATION_RESULTS: record });

  const csv = [
    `# backend: WebGPU (f32 deltas) vs the mpmath references in paper/data/validation/`,
    `# adapter: ${adapter}`,
    `# browser: ${navigator.userAgent}`,
    "# regenerate: npm run dev, then open /?validate",
    `# gate: medianAbsIter <= ${MAX_MEDIAN_ABS_ITER}, offByOne <= ${MAX_OFF_BY_ONE_PCT}% of pixels, ` +
      `interiorFlips <= ${MAX_INTERIOR_FLIPS_PCT}% of pixels`,
    `# overTolerance counts escape times more than ${RAW_TOLERANCE} iteration off; offByOne, more than 1`,
    "id,scale,maxIter,pixels,interiorFlips,overTolerance,offByOne,medianAbsIter,maxAbsIter," +
      "meanAbsRgb,maxAbsRgb,differingPixels,worseThan4,verdict",
    ...metrics.map((m) =>
      [
        m.id,
        m.scale.toExponential(6),
        m.maxIter,
        m.pixels,
        m.interiorFlips,
        m.overTolerance,
        m.offByOne,
        m.medianAbsIter.toExponential(3),
        m.maxAbsIter.toFixed(3),
        m.meanAbsRgb.toFixed(6),
        m.maxAbsRgb,
        m.differingPixels,
        m.worseThan4,
        m.pass ? "PASS" : "FAIL",
      ].join(","),
    ),
  ].join("\n");
  page.addDownload("Download webgpu_validation.csv", "webgpu_validation.csv", csv + "\n");
}
