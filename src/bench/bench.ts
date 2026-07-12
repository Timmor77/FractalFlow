// In-browser benchmark harness, opened via `/?bench` (see main.ts).
//
// Measures GPU throughput of the WebGPU and WebGL2 backends on the same
// (scale, maxIter) schedule as the CUDA benchmark, at a fixed 1920×1080:
//   - WebGPU renders into an OFF-SCREEN texture (no canvas presentation, no
//     requestAnimationFrame), timed with device.queue.onSubmittedWorkDone();
//   - WebGL2 renders into a hidden fixed-size canvas, timed with gl.finish();
//   - each depth runs 3 warm-up frames then reports the MEDIAN of 5 timed
//     frames (the reference orbit is cached after the first frame, so timed
//     frames measure pure GPU work);
//   - a mean-luma readback guards against silently-black output.
//
// Results are shown as a table and downloadable as CSV files whose columns
// match cuda/julia.cu's benchmark output (plus meanLuma), ready for
// scripts/benchmark.py.

import type { ViewState } from "../core/types";
import { WebGPURenderer } from "../backends/webgpu/webgpuRenderer";
import { WebGLRenderer } from "../backends/webgl/webglRenderer";
import {
  BENCH_SCHEDULE,
  BENCH_WIDTH,
  BENCH_HEIGHT,
  BENCH_CENTER,
  BENCH_C,
} from "./schedule";

const WARMUP_FRAMES = 3;
const TIMED_FRAMES = 5;

type BenchRow = {
  scale: number;
  maxIter: number;
  ms: number;
  gIterPerSec: number;
  mpixPerSec: number;
  meanLuma: number;
};

type BackendResult = {
  backend: string;
  gpu: string;
  rows: BenchRow[];
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

// Greyscale LUT: palette choice does not affect iteration cost, and grey makes
// the luma sanity check straightforward.
function makeGreyLut(): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    lut[i * 4] = i;
    lut[i * 4 + 1] = i;
    lut[i * 4 + 2] = i;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

function makeView(scale: number, maxIter: number, lut: Uint8Array): ViewState {
  return {
    centerX: { hi: BENCH_CENTER.x, lo: 0 },
    centerY: { hi: BENCH_CENTER.y, lo: 0 },
    scale,
    cx: BENCH_C.x,
    cy: BENCH_C.y,
    maxIter,
    paletteLut: lut,
  };
}

function toRow(scale: number, maxIter: number, ms: number, meanLuma: number): BenchRow {
  const pixels = BENCH_WIDTH * BENCH_HEIGHT;
  return {
    scale,
    maxIter,
    ms,
    // Upper bound (assumes every pixel reaches maxIter) — same convention as
    // the CUDA benchmark, so the numbers stay comparable.
    gIterPerSec: (pixels * maxIter) / (ms * 1e-3) / 1e9,
    mpixPerSec: pixels / (ms * 1e-3) / 1e6,
    meanLuma,
  };
}

async function describeAdapter(): Promise<string> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    return "unknown";
  }
  const info = adapter.info;
  return [info.vendor, info.architecture, info.device, info.description]
    .filter((part) => part && part.length > 0)
    .join(" / ");
}

// --- WebGPU: off-screen texture rendering + buffer readback ---

async function benchWebGpu(log: (line: string) => void): Promise<BackendResult> {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:-9999px;width:64px;height:64px";
  document.body.appendChild(canvas);

  const renderer = await WebGPURenderer.create(canvas);
  const device = renderer.gpuDevice;
  const gpu = await describeAdapter();
  log(`WebGPU adapter: ${gpu}`);

  const format = navigator.gpu.getPreferredCanvasFormat();
  const target = device.createTexture({
    size: [BENCH_WIDTH, BENCH_HEIGHT],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const targetView = target.createView();

  // 1920 × 4 = 7680 bytes/row, already a multiple of the required 256.
  const bytesPerRow = BENCH_WIDTH * 4;
  const readback = device.createBuffer({
    size: bytesPerRow * BENCH_HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const lut = makeGreyLut();
  const rows: BenchRow[] = [];

  for (const point of BENCH_SCHEDULE) {
    const view = makeView(point.scale, point.maxIter, lut);

    for (let i = 0; i < WARMUP_FRAMES; i++) {
      renderer.renderToTexture(view, targetView, BENCH_WIDTH, BENCH_HEIGHT);
      await device.queue.onSubmittedWorkDone();
    }

    const times: number[] = [];
    for (let i = 0; i < TIMED_FRAMES; i++) {
      const t0 = performance.now();
      renderer.renderToTexture(view, targetView, BENCH_WIDTH, BENCH_HEIGHT);
      await device.queue.onSubmittedWorkDone();
      times.push(performance.now() - t0);
    }

    // Sanity readback (outside the timed section).
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow },
      [BENCH_WIDTH, BENCH_HEIGHT],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(readback.getMappedRange());
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4 * 997) {
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3; // channel order irrelevant for luma
      count++;
    }
    readback.unmap();
    const meanLuma = count > 0 ? sum / count : 0;

    const row = toRow(point.scale, point.maxIter, median(times), meanLuma);
    rows.push(row);
    log(
      `WebGPU  scale=${point.scale.toExponential(1)} iter=${point.maxIter}  ` +
        `${row.ms.toFixed(2)} ms  ${row.gIterPerSec.toFixed(2)} GIter/s  luma=${meanLuma.toFixed(1)}`,
    );
  }

  canvas.remove();
  return { backend: "WebGPU", gpu, rows };
}

// --- WebGL2: hidden fixed-size canvas + gl.finish() timing ---

async function benchWebGl(log: (line: string) => void): Promise<BackendResult> {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:-9999px;width:64px;height:64px";
  document.body.appendChild(canvas);

  const renderer = new WebGLRenderer(canvas);
  renderer.setExactSize(BENCH_WIDTH, BENCH_HEIGHT);
  const gpu = (() => {
    const gl = canvas.getContext("webgl2");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    return dbg && gl ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "unknown";
  })();
  log(`WebGL2 renderer: ${gpu}`);

  const lut = makeGreyLut();
  const rows: BenchRow[] = [];

  for (const point of BENCH_SCHEDULE) {
    const view = makeView(point.scale, point.maxIter, lut);

    for (let i = 0; i < WARMUP_FRAMES; i++) {
      renderer.render(view);
      renderer.finish();
    }

    const times: number[] = [];
    for (let i = 0; i < TIMED_FRAMES; i++) {
      renderer.finish();
      const t0 = performance.now();
      renderer.render(view);
      renderer.finish();
      times.push(performance.now() - t0);
    }

    renderer.render(view);
    renderer.finish();
    const meanLuma = renderer.sampleMeanLuma();

    const row = toRow(point.scale, point.maxIter, median(times), meanLuma);
    rows.push(row);
    log(
      `WebGL2  scale=${point.scale.toExponential(1)} iter=${point.maxIter}  ` +
        `${row.ms.toFixed(2)} ms  ${row.gIterPerSec.toFixed(2)} GIter/s  luma=${meanLuma.toFixed(1)}`,
    );

    // Yield to the event loop so the page stays responsive between depths.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  canvas.remove();
  return { backend: "WebGL2", gpu, rows };
}

// --- Output ---

function toCsv(result: BackendResult): string {
  const lines = [
    `# backend: ${result.backend}`,
    `# gpu: ${result.gpu}`,
    `# resolution: ${BENCH_WIDTH}x${BENCH_HEIGHT}, median of ${TIMED_FRAMES} frames after ${WARMUP_FRAMES} warm-ups`,
    "scale,maxIter,ms,GIterPerSec,MpixPerSec,meanLuma",
  ];
  for (const row of result.rows) {
    lines.push(
      `${row.scale.toExponential(6)},${row.maxIter},${row.ms.toFixed(3)},` +
        `${row.gIterPerSec.toFixed(3)},${row.mpixPerSec.toFixed(1)},${row.meanLuma.toFixed(1)}`,
    );
  }
  return lines.join("\n") + "\n";
}

function makeDownloadButton(label: string, filename: string, content: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = label;
  button.style.cssText =
    "margin:6px 8px 0 0;padding:8px 14px;border-radius:8px;border:1px solid #445;" +
    "background:#1c2333;color:#e8ecf4;font-size:13px;cursor:pointer";
  button.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  });
  return button;
}

// Entry point. mode: "webgpu" | "webgl" | "" (both).
export async function runBench(mode: string): Promise<void> {
  document.title = "FractalFlow — benchmark";
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    throw new Error("#app element not found");
  }
  app.innerHTML = "";
  app.style.cssText =
    "min-height:100vh;background:#0b0e16;color:#e8ecf4;padding:24px;box-sizing:border-box;" +
    "font-family:Consolas,Monaco,monospace;font-size:13px;overflow:auto";

  const title = document.createElement("h1");
  title.textContent = "FractalFlow benchmark";
  title.style.cssText = "font-size:18px;margin:0 0 4px";
  const subtitle = document.createElement("div");
  subtitle.textContent =
    `${BENCH_WIDTH}×${BENCH_HEIGHT}, ${BENCH_SCHEDULE.length} zoom depths, ` +
    `median of ${TIMED_FRAMES} frames (${WARMUP_FRAMES} warm-ups)`;
  subtitle.style.cssText = "color:#9aa4b8;margin-bottom:16px";
  const pre = document.createElement("pre");
  pre.style.cssText = "white-space:pre-wrap;line-height:1.5;margin:0";
  const actions = document.createElement("div");
  app.append(title, subtitle, pre, actions);

  const log = (line: string): void => {
    pre.textContent += line + "\n";
  };

  const results: BackendResult[] = [];
  const wantWebGpu = mode === "" || mode === "all" || mode === "webgpu";
  const wantWebGl = mode === "" || mode === "all" || mode === "webgl";

  if (wantWebGpu) {
    try {
      results.push(await benchWebGpu(log));
    } catch (error) {
      log(`WebGPU benchmark skipped: ${error}`);
    }
  }
  if (wantWebGl) {
    try {
      results.push(await benchWebGl(log));
    } catch (error) {
      log(`WebGL2 benchmark skipped: ${error}`);
    }
  }

  log("\nDone. Download the CSVs below and plot them with scripts/benchmark.py.");
  for (const result of results) {
    const filename = `${result.backend.toLowerCase()}_bench.csv`;
    actions.appendChild(makeDownloadButton(`Download ${filename}`, filename, toCsv(result)));
  }

  // Machine-readable dump for automated runs.
  console.log("FRACTALFLOW_BENCH_RESULTS " + JSON.stringify(results));
}
