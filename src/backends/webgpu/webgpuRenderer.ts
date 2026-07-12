// WebGPU render backend (the modern, fast, "for everyone" version).
//
// It computes the reference orbit on the CPU (high precision), uploads it to
// the GPU in a storage buffer, then draws a fullscreen triangle whose fragment
// shader iterates the perturbation in f32 (see julia.wgsl).

import type { Renderer, ViewState, RenderInfo } from "../../core/types";
import { computeReferenceOrbit } from "../../core/referenceOrbit";
import { canvasToPng } from "../../core/image";
import { MAX_ITER_LIMIT, MAX_DPR } from "../../core/config";

// The shader is imported as raw text (Vite, ?raw); it stays in its own file.
import shaderCode from "./julia.wgsl?raw";

// Size of the uniform block (see struct Uniforms in the shader).
// resolution(8) + scale(4) + aspect(4) + maxIter(4) + refLength(4) = 24, rounded up to 32.
const UNIFORM_SIZE = 32;

// Width of the palette colour lookup table (LUT). See ui/palettes.ts.
const PALETTE_SIZE = 256;

export class WebGPURenderer implements Renderer {
  public readonly name = "WebGPU";

  private readonly canvas: HTMLCanvasElement;
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly pipeline: GPURenderPipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly orbitBuffer: GPUBuffer;
  private readonly paletteTexture: GPUTexture;
  private readonly bindGroup: GPUBindGroup;

  // Reused CPU buffer for writing uniforms (avoids per-frame reallocation).
  private readonly uniformData = new ArrayBuffer(UNIFORM_SIZE);

  // Last uploaded palette LUT: we only re-upload on change.
  private lastLut: Uint8Array | null = null;

  // Reference orbit cache: recompute (and re-upload) only when the centre, c or
  // maxIter change. Useful for the sharp pass after motion stops, a palette
  // change, a resize... (same parameters -> same orbit).
  private lastOrbit: { data: Float32Array; length: number } | null = null;
  private lastOrbitKey = "";

  private constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    module: GPUShaderModule,
  ) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;

    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Orbit buffer sized once for the iteration cap.
    // MAX_ITER_LIMIT points × (x, y) × 4 bytes. ~32 KB: negligible.
    this.orbitBuffer = device.createBuffer({
      size: MAX_ITER_LIMIT * 2 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Palette texture (256×1) + repeating/linear sampler.
    this.paletteTexture = device.createTexture({
      size: [PALETTE_SIZE, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const paletteSampler = device.createSampler({
      addressModeU: "repeat",
      magFilter: "linear",
      minFilter: "linear",
    });

    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.orbitBuffer } },
        { binding: 2, resource: this.paletteTexture.createView() },
        { binding: 3, resource: paletteSampler },
      ],
    });

    this.resize();
  }

  // Async factory: WebGPU initializes asynchronously.
  // Throws if WebGPU is unavailable (the caller falls back to WebGL2).
  public static async create(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
    if (!navigator.gpu) {
      throw new Error("WebGPU is not supported by this browser");
    }

    // On dual-GPU laptops, explicitly request the high-performance GPU.
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      throw new Error("No WebGPU adapter available");
    }

    const device = await adapter.requestDevice();

    // A device can be lost at any point (driver, sleep, Windows TDR).
    // We cannot re-create the renderer from here, but we make the failure
    // visible instead of leaving an unexplained frozen screen.
    device.lost.then((info) => {
      if (info.reason !== "destroyed") {
        console.error(`WebGPU device lost (${info.reason}): ${info.message}. Reload the page.`);
      }
    });

    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new Error("Could not get a WebGPU context");
    }

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });

    // Compile the shader and check for errors BEFORE continuing: a WGSL error
    // does not throw synchronously, so without this check a broken shader would
    // produce a silent black screen instead of falling back to WebGL2.
    const module = device.createShaderModule({ code: shaderCode });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length > 0) {
      throw new Error(`WGSL shader compilation failed: ${errors[0].message}`);
    }

    return new WebGPURenderer(canvas, device, context, format, module);
  }

  // Device access for the benchmark harness (frame timing via
  // onSubmittedWorkDone, off-screen texture creation and readback).
  public get gpuDevice(): GPUDevice {
    return this.device;
  }

  public render(view: ViewState): RenderInfo {
    return this.renderToTexture(
      view,
      this.context.getCurrentTexture().createView(),
      this.canvas.width,
      this.canvas.height,
    );
  }

  // Renders one frame into an arbitrary texture view. Used by render() for
  // the canvas, and by the benchmark harness for a fixed-size off-screen
  // target (which sidesteps canvas presentation entirely).
  public renderToTexture(
    view: ViewState,
    target: GPUTextureView,
    width: number,
    height: number,
  ): RenderInfo {
    const start = performance.now();
    const device = this.device;

    // 1) Reference orbit (CPU, high precision) -> GPU. Cached: recompute +
    //    upload only when the centre / c / maxIter changed.
    const key = `${view.centerX.hi},${view.centerX.lo},${view.centerY.hi},${view.centerY.lo},${view.cx},${view.cy},${view.maxIter}`;
    let orbit = this.lastOrbit;
    if (orbit === null || key !== this.lastOrbitKey) {
      orbit = computeReferenceOrbit(view.centerX, view.centerY, view.cx, view.cy, view.maxIter);
      device.queue.writeBuffer(this.orbitBuffer, 0, orbit.data, 0, orbit.length * 2);
      this.lastOrbit = orbit;
      this.lastOrbitKey = key;
    }

    // 2) Palette: upload the LUT texture only when it changed.
    if (view.paletteLut !== this.lastLut) {
      device.queue.writeTexture(
        { texture: this.paletteTexture },
        view.paletteLut,
        { bytesPerRow: PALETTE_SIZE * 4, rowsPerImage: 1 },
        { width: PALETTE_SIZE, height: 1 },
      );
      this.lastLut = view.paletteLut;
    }

    // 3) Uniforms (see struct Uniforms).
    const f = new Float32Array(this.uniformData);
    const uint = new Uint32Array(this.uniformData);
    f[0] = width;
    f[1] = height;
    f[2] = view.scale;
    f[3] = width / height;
    uint[4] = view.maxIter;
    uint[5] = orbit.length;
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    // 4) Render pass: fullscreen triangle (3 vertices).
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return { cpuMs: performance.now() - start, refLength: orbit.length };
  }

  // Adjusts the canvas's internal resolution. qualityScale reduces resolution
  // during interaction to stay smooth (DPR capped).
  public resize(qualityScale = 1): void {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr * qualityScale));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr * qualityScale));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  // Full-quality export: grow the canvas backing store to the requested size
  // (the CSS display size does not change), draw one frame, read the PNG, then
  // restore the display size. Clamped to the GPU's max texture size (keeping
  // aspect) so it can never fail silently.
  public async capture(view: ViewState, width: number, height: number): Promise<Blob> {
    const max = this.device.limits.maxTextureDimension2D;
    const scale = Math.min(1, max / Math.max(width, height));
    this.canvas.width = Math.max(1, Math.floor(width * scale));
    this.canvas.height = Math.max(1, Math.floor(height * scale));
    this.render(view);
    const blob = await canvasToPng(this.canvas);
    this.resize();
    this.render(view); // leave a sharp frame on screen after the export
    return blob;
  }
}
