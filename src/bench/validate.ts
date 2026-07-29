// In-browser validation harness, opened via `/?validate` (see main.ts).
//
// The frozen release matrix (paper/data/validation) is produced by CUDA against
// an arbitrary-precision mpmath reference. It says nothing about the browser,
// whose per-pixel deltas are f32 rather than f64. This harness closes that gap
// from the other side: it re-renders the same cases with the WebGPU backend,
// at the same size, from the same double-double centres, and compares them
// pixel by pixel with the same archived reference PNGs.
//
// Two effects show up and are reported separately, because they have nothing to
// do with each other:
//   - colouring. The shaders sample a 256-entry palette LUT with linear
//     interpolation; the Python reference evaluates the gradient analytically.
//     That alone moves most pixels by a level or two and cannot be fixed by
//     precision.
//   - dynamics. Interior/exterior flips are palette-independent: they count
//     pixels where the two implementations disagree on whether the orbit
//     escaped at all. This is the number to watch.
//
// Results are logged as FRACTALFLOW_VALIDATION_RESULTS, exposed on
// window.FRACTALFLOW_VALIDATION_PNGS for automated capture, and offered as
// downloads.

import type { ViewState } from "../core/types";
import { WebGPURenderer } from "../backends/webgpu/webgpuRenderer";
import { PALETTES, DEFAULT_PALETTE, buildPaletteLut } from "../ui/palettes";

// The archived matrix, served from the repository by the dev server.
const RESULTS_CSV = "/paper/data/validation/validation_results.csv";
const REFERENCE_DIR = "/paper/data/validation/";

type Row = Record<string, string>;

type CaseMetrics = {
  id: string;
  scale: number;
  maxIter: number;
  meanAbsRgb: number;
  maxAbsRgb: number;
  differingPixels: number;
  worseThan4: number;
  interiorFlips: number;
  pixels: number;
};

function parseCsv(text: string): Row[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((name, i) => [name, cells[i]])) as Row;
  });
}

// Reads back an offscreen render as tightly packed RGB, undoing the BGRA
// channel order the preferred canvas format usually asks for.
async function readTargetRgb(
  device: GPUDevice,
  target: GPUTexture,
  buffer: GPUBuffer,
  bytesPerRow: number,
  width: number,
  height: number,
  bgra: boolean,
): Promise<Uint8Array> {
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [width, height]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();

  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = y * bytesPerRow + x * 4;
      const dst = (y * width + x) * 3;
      rgb[dst] = bgra ? mapped[src + 2] : mapped[src];
      rgb[dst + 1] = mapped[src + 1];
      rgb[dst + 2] = bgra ? mapped[src] : mapped[src + 2];
    }
  }
  return rgb;
}

async function loadReferenceRgb(file: string, width: number, height: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(await (await fetch(REFERENCE_DIR + file)).blob());
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2D context unavailable for reference decoding");
  }
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    rgb[p * 3] = data[p * 4];
    rgb[p * 3 + 1] = data[p * 4 + 1];
    rgb[p * 3 + 2] = data[p * 4 + 2];
  }
  return rgb;
}

function compare(candidate: Uint8Array, reference: Uint8Array, pixels: number) {
  let sum = 0;
  let max = 0;
  let differing = 0;
  let worseThan4 = 0;
  let flips = 0;
  for (let p = 0; p < pixels; p++) {
    let pixelMax = 0;
    for (let k = 0; k < 3; k++) {
      const delta = Math.abs(candidate[p * 3 + k] - reference[p * 3 + k]);
      sum += delta;
      pixelMax = Math.max(pixelMax, delta);
    }
    max = Math.max(max, pixelMax);
    if (pixelMax > 0) differing++;
    if (pixelMax > 4) worseThan4++;
    const candidateInterior =
      candidate[p * 3] === 0 && candidate[p * 3 + 1] === 0 && candidate[p * 3 + 2] === 0;
    const referenceInterior =
      reference[p * 3] === 0 && reference[p * 3 + 1] === 0 && reference[p * 3 + 2] === 0;
    if (candidateInterior !== referenceInterior) flips++;
  }
  return { sum, max, differing, worseThan4, flips };
}

// Encodes tightly packed RGB as a PNG data URL, for archiving next to the CUDA
// candidates.
async function toPngDataUrl(rgb: Uint8Array, width: number, height: number): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(width, height);
  for (let p = 0; p < width * height; p++) {
    image.data[p * 4] = rgb[p * 3];
    image.data[p * 4 + 1] = rgb[p * 3 + 1];
    image.data[p * 4 + 2] = rgb[p * 3 + 2];
    image.data[p * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

export async function runValidation(): Promise<void> {
  document.title = "FractalFlow — WebGPU validation";
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    throw new Error("#app element not found");
  }
  app.innerHTML = "";
  app.style.cssText =
    "min-height:100vh;background:#0b0e16;color:#e8ecf4;padding:24px;box-sizing:border-box;" +
    "font-family:Consolas,Monaco,monospace;font-size:13px;overflow:auto";
  const pre = document.createElement("pre");
  pre.style.cssText = "white-space:pre-wrap;line-height:1.5;margin:0";
  const actions = document.createElement("div");
  app.append(pre, actions);
  const log = (line: string): void => {
    pre.textContent += line + "\n";
  };

  log("WebGPU backend vs the archived arbitrary-precision references");
  log("");

  const rows = parseCsv(await (await fetch(RESULTS_CSV)).text());
  const lut = buildPaletteLut(PALETTES[DEFAULT_PALETTE]);

  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  canvas.style.cssText = "position:fixed;left:-9999px";
  document.body.appendChild(canvas);
  const renderer = await WebGPURenderer.create(canvas);
  const device = renderer.gpuDevice;
  const format = navigator.gpu.getPreferredCanvasFormat();
  const bgra = format.startsWith("bgra");

  const metrics: CaseMetrics[] = [];
  const pngs: Record<string, string> = {};

  for (const row of rows) {
    const width = Number(row.width);
    const height = Number(row.height);
    // 256 is the minimum row alignment for texture-to-buffer copies; the
    // 64-pixel cases need the padding, so the readback un-pads.
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const target = device.createTexture({
      size: [width, height],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const buffer = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const view: ViewState = {
      centerX: { hi: Number(row.center_re_hi), lo: Number(row.center_re_lo) },
      centerY: { hi: Number(row.center_im_hi), lo: Number(row.center_im_lo) },
      scale: Number(row.scale),
      cx: Number(row.c_re),
      cy: Number(row.c_im),
      maxIter: Number(row.max_iter),
      paletteLut: lut,
    };

    renderer.renderToTexture(view, target.createView(), width, height);
    await device.queue.onSubmittedWorkDone();
    const candidate = await readTargetRgb(device, target, buffer, bytesPerRow, width, height, bgra);
    const reference = await loadReferenceRgb(row.reference_file, width, height);
    const pixels = width * height;
    const result = compare(candidate, reference, pixels);

    metrics.push({
      id: row.id,
      scale: Number(row.scale),
      maxIter: Number(row.max_iter),
      meanAbsRgb: result.sum / (pixels * 3),
      maxAbsRgb: result.max,
      differingPixels: result.differing,
      worseThan4: result.worseThan4,
      interiorFlips: result.flips,
      pixels,
    });
    pngs[row.id] = await toPngDataUrl(candidate, width, height);

    log(
      `${row.id.padEnd(18)} scale=${Number(row.scale).toExponential(0).padStart(7)} ` +
        `mean=${(result.sum / (pixels * 3)).toFixed(3).padStart(7)} ` +
        `max=${String(result.max).padStart(3)} ` +
        `differ=${String(result.differing).padStart(4)}/${pixels} ` +
        `>4=${String(result.worseThan4).padStart(4)} ` +
        `flips=${String(result.flips).padStart(3)}`,
    );

    target.destroy();
    buffer.destroy();
  }

  canvas.remove();

  log("");
  log("differ/>4 include the palette LUT sampling difference; flips do not.");

  const record = {
    backend: "WebGPU",
    browser: navigator.userAgent,
    cases: metrics,
  };
  console.log("FRACTALFLOW_VALIDATION_RESULTS " + JSON.stringify(record));
  Object.assign(window, {
    FRACTALFLOW_VALIDATION_RESULTS: record,
    FRACTALFLOW_VALIDATION_PNGS: pngs,
  });

  const csv = [
    `# backend: WebGPU (f32 deltas) vs mpmath references in ${REFERENCE_DIR}`,
    `# browser: ${navigator.userAgent}`,
    "# differingPixels/worseThan4 include the palette LUT sampling difference; interiorFlips do not",
    "id,scale,maxIter,meanAbsRgb,maxAbsRgb,differingPixels,worseThan4,interiorFlips,pixels",
    ...metrics.map((m) =>
      [
        m.id,
        m.scale.toExponential(6),
        m.maxIter,
        m.meanAbsRgb.toFixed(6),
        m.maxAbsRgb,
        m.differingPixels,
        m.worseThan4,
        m.interiorFlips,
        m.pixels,
      ].join(","),
    ),
  ].join("\n");

  const button = document.createElement("button");
  button.textContent = "Download webgpu_validation.csv";
  button.style.cssText =
    "margin:12px 8px 0 0;padding:8px 14px;border-radius:8px;border:1px solid #445;" +
    "background:#1c2333;color:#e8ecf4;font-size:13px;cursor:pointer";
  button.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "webgpu_validation.csv";
    link.click();
    URL.revokeObjectURL(url);
  });
  actions.appendChild(button);
}
