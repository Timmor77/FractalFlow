// WebGPU render backend (the modern, fast, "for everyone" version).
//
// It computes the reference orbit on the CPU (high precision), uploads it to
// the GPU in a storage buffer, then draws a fullscreen triangle whose fragment
// shader iterates the perturbation in f32 (see julia.wgsl).
//
// Three ways to draw the same view:
//   render()      the canvas, for the interactive app;
//   renderTile()  a rectangle of a larger image, read back as pixels — the
//                 building block of the tiled PNG export;
//   renderRaw()   the smooth iteration counts themselves, for validation.

import type { Renderer, ViewState, RenderInfo, ImageSize, Tile } from "../../core/types";
import { OrbitBuffer } from "../../core/referenceOrbit";
import { MAX_ITER_LIMIT, MAX_DPR, VALIDATED_MIN_SCALE } from "../../core/config";

// The shader is imported as raw text (Vite, ?raw); it stays in its own file.
import shaderCode from "./julia.wgsl?raw";

// Size of the uniform block (see struct Uniforms in the shader).
// resolution(8) + scale(4) + aspect(4) + maxIter(4) + refLength(4) + center(8)
// + origin(8) = 40.
const UNIFORM_SIZE = 40;

// Width of the palette colour lookup table (LUT). See ui/palettes.ts.
const PALETTE_SIZE = 256;

// Texture-to-buffer copies need each row to start on a multiple of 256 bytes.
function alignedBytesPerRow(width: number, bytesPerPixel: number): number {
  return Math.ceil((width * bytesPerPixel) / 256) * 256;
}

// Where a draw lands: the size of the whole image the view is mapped onto,
// and the top-left corner and size of the part actually rasterised.
type DrawRegion = {
  imageWidth: number;
  imageHeight: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
};

// A render target with the buffer used to read it back, grown on demand.
type ReadbackTarget = {
  texture: GPUTexture;
  view: GPUTextureView;
  buffer: GPUBuffer;
  width: number;
  height: number;
  bytesPerRow: number;
};

export class WebGPURenderer implements Renderer {
  public readonly name = "WebGPU";

  // Perturbation with a double-double reference (~31 digits). The floor is the
  // deepest scale the release validates against arbitrary precision, not the
  // representation's theoretical reach — see core/viewport.ts and the archived
  // depth sweep.
  public readonly minScale = VALIDATED_MIN_SCALE;

  private readonly canvas: HTMLCanvasElement;
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly module: GPUShaderModule;
  private readonly pipeline: GPURenderPipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly orbitBuffer: GPUBuffer;
  private readonly paletteTexture: GPUTexture;
  private readonly bindGroup: GPUBindGroup;

  // Reused CPU buffer for writing uniforms (avoids per-frame reallocation).
  private readonly uniformData = new ArrayBuffer(UNIFORM_SIZE);
  private readonly uniformFloats = new Float32Array(this.uniformData);
  private readonly uniformUints = new Uint32Array(this.uniformData);

  // Last uploaded palette LUT: we only re-upload on change.
  private lastLut: Uint8Array | null = null;

  // Reference orbit: recomputed (and re-uploaded) only when the centre, c or
  // maxIter change. Useful for the sharp pass after motion stops, a palette
  // change, a resize, every tile of an export... (same parameters -> same
  // orbit). The storage is reused from one orbit to the next.
  private readonly orbit = new OrbitBuffer(MAX_ITER_LIMIT);
  private orbitKey = "";

  // Created on first use: the export and the validation harness need them,
  // the interactive app does not.
  private tileTarget: ReadbackTarget | null = null;
  private rawTarget: ReadbackTarget | null = null;
  private rawPipeline: { pipeline: GPURenderPipeline; bindGroup: GPUBindGroup } | null = null;

  private constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    module: GPUShaderModule,
    pipeline: GPURenderPipeline,
  ) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;
    this.module = module;
    this.pipeline = pipeline;

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
  //
  // `onDeviceLost` is called if the GPU device disappears later (driver reset,
  // sleep, Windows TDR): nothing drawn after that point reaches the screen, so
  // the caller must tell the user instead of leaving a frozen image.
  public static async create(
    canvas: HTMLCanvasElement,
    onDeviceLost?: (message: string) => void,
  ): Promise<WebGPURenderer> {
    if (!navigator.gpu) {
      throw new Error("WebGPU is not supported by this browser");
    }

    // On dual-GPU laptops, explicitly request the high-performance GPU.
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      throw new Error("No WebGPU adapter available");
    }

    const device = await adapter.requestDevice();

    void device.lost.then((info) => {
      if (info.reason !== "destroyed") {
        console.error(`WebGPU device lost (${info.reason}): ${info.message}. Reload the page.`);
        onDeviceLost?.(info.message);
      }
    });

    try {
      // Everything that can fail runs BEFORE the canvas is bound to WebGPU. A
      // canvas that has handed out a "webgpu" context can never give a
      // "webgl2" one afterwards, so failing later would break the fallback.
      const format = navigator.gpu.getPreferredCanvasFormat();

      // A WGSL error does not throw synchronously: without this check a broken
      // shader would produce a silent black screen instead of a fallback.
      const module = device.createShaderModule({ code: shaderCode });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === "error");
      if (errors.length > 0) {
        throw new Error(`WGSL shader compilation failed: ${errors[0].message}`);
      }

      // The async variant rejects when the driver refuses the pipeline (for
      // instance a backend shader translation failure); the sync one would
      // only report it later, as an uncaptured validation error.
      const pipeline = await device.createRenderPipelineAsync({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });

      const context = canvas.getContext("webgpu");
      if (!context) {
        throw new Error("Could not get a WebGPU context");
      }
      context.configure({ device, format, alphaMode: "opaque" });

      return new WebGPURenderer(canvas, device, context, format, module, pipeline);
    } catch (error) {
      device.destroy(); // reason "destroyed": does not trigger onDeviceLost
      throw error;
    }
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

  // Renders one full frame into an arbitrary texture view. Used by render()
  // for the canvas, and by the benchmark harness for a fixed-size off-screen
  // target (which sidesteps canvas presentation entirely).
  public renderToTexture(
    view: ViewState,
    target: GPUTextureView,
    width: number,
    height: number,
  ): RenderInfo {
    const start = performance.now();
    const refLength = this.draw(view, target, this.pipeline, this.bindGroup, {
      imageWidth: width,
      imageHeight: height,
      originX: 0,
      originY: 0,
      width,
      height,
    });
    return { cpuMs: performance.now() - start, refLength };
  }

  // One tile of a larger image, as tightly packed RGBA rows from the top.
  // The shader maps pixels from the image size and the tile origin, so the
  // tile holds exactly the pixels a single full-size draw would produce.
  public async renderTile(view: ViewState, image: ImageSize, tile: Tile): Promise<Uint8Array> {
    const target = this.ensureTarget("tile", tile.width, tile.height);
    this.draw(view, target.view, this.pipeline, this.bindGroup, {
      imageWidth: image.width,
      imageHeight: image.height,
      originX: tile.x,
      originY: tile.y,
      width: tile.width,
      height: tile.height,
    });
    const mapped = await this.readBack(target, tile.width, tile.height);

    // Un-pad the rows, and undo the BGRA order most canvas formats use.
    const bgra = this.format.startsWith("bgra");
    const pixels = new Uint8Array(tile.width * tile.height * 4);
    for (let y = 0; y < tile.height; y++) {
      const row = mapped.subarray(y * target.bytesPerRow, y * target.bytesPerRow + tile.width * 4);
      const out = y * tile.width * 4;
      if (bgra) {
        for (let i = 0; i < row.length; i += 4) {
          pixels[out + i] = row[i + 2];
          pixels[out + i + 1] = row[i + 1];
          pixels[out + i + 2] = row[i];
          pixels[out + i + 3] = row[i + 3];
        }
      } else {
        pixels.set(row, out);
      }
    }
    target.buffer.unmap();
    return pixels;
  }

  // The smooth iteration count of every pixel, before any colouring: row-major
  // from the top, -1 for pixels that never escape. Same layout and sentinel as
  // the CUDA --raw dump and the Python reference.
  public async renderRaw(view: ViewState, width: number, height: number): Promise<Float32Array> {
    if (this.rawPipeline === null) {
      // Same module, other fragment entry point: the iteration is shared with
      // the colour path, only the output differs.
      const pipeline = await this.device.createRenderPipelineAsync({
        layout: "auto",
        vertex: { module: this.module, entryPoint: "vs" },
        fragment: { module: this.module, entryPoint: "fsRaw", targets: [{ format: "r32float" }] },
        primitive: { topology: "triangle-list" },
      });
      // fsRaw does not touch the palette, so its auto layout has no slot for it.
      const bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.orbitBuffer } },
        ],
      });
      this.rawPipeline = { pipeline, bindGroup };
    }

    const target = this.ensureTarget("raw", width, height);
    this.draw(view, target.view, this.rawPipeline.pipeline, this.rawPipeline.bindGroup, {
      imageWidth: width,
      imageHeight: height,
      originX: 0,
      originY: 0,
      width,
      height,
    });
    const mapped = await this.readBack(target, width, height);
    const raw = new Float32Array(width * height);
    const floatsPerRow = target.bytesPerRow / 4;
    const padded = new Float32Array(mapped.buffer, mapped.byteOffset, mapped.byteLength / 4);
    for (let y = 0; y < height; y++) {
      raw.set(padded.subarray(y * floatsPerRow, y * floatsPerRow + width), y * width);
    }
    target.buffer.unmap();
    return raw;
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

  // Uploads whatever changed (orbit, palette, uniforms) and submits one draw.
  // Returns the reference orbit length.
  private draw(
    view: ViewState,
    target: GPUTextureView,
    pipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
    region: DrawRegion,
  ): number {
    const device = this.device;

    // 1) Reference orbit (CPU, high precision) -> GPU. Cached: recompute +
    //    upload only when the centre / c / maxIter changed.
    const key = `${view.centerX.hi},${view.centerX.lo},${view.centerY.hi},${view.centerY.lo},${view.cx},${view.cy},${view.maxIter}`;
    if (key !== this.orbitKey) {
      this.orbit.compute(view.centerX, view.centerY, view.cx, view.cy, view.maxIter);
      device.queue.writeBuffer(this.orbitBuffer, 0, this.orbit.data, 0, this.orbit.length * 2);
      this.orbitKey = key;
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
    const f = this.uniformFloats;
    const uint = this.uniformUints;
    f[0] = region.imageWidth;
    f[1] = region.imageHeight;
    f[2] = view.scale;
    f[3] = region.imageWidth / region.imageHeight;
    uint[4] = view.maxIter;
    uint[5] = this.orbit.length;
    // Z0 in f32: the orbit buffer stores offsets relative to it (the
    // Float32Array assignment performs the float64 -> float32 rounding).
    f[6] = view.centerX.hi + view.centerX.lo;
    f[7] = view.centerY.hi + view.centerY.lo;
    f[8] = region.originX;
    f[9] = region.originY;
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    // 4) Render pass: fullscreen triangle (3 vertices), clipped to the region
    //    when the target is larger than what this draw covers.
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
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setViewport(0, 0, region.width, region.height, 0, 1);
    pass.setScissorRect(0, 0, region.width, region.height);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return this.orbit.length;
  }

  // Returns the off-screen target of the given kind, (re)created when the
  // requested size does not fit the current one.
  private ensureTarget(kind: "tile" | "raw", width: number, height: number): ReadbackTarget {
    const current = kind === "tile" ? this.tileTarget : this.rawTarget;
    if (current !== null && current.width >= width && current.height >= height) {
      return current;
    }
    current?.texture.destroy();
    current?.buffer.destroy();

    const format = kind === "tile" ? this.format : "r32float";
    const texture = this.device.createTexture({
      size: [width, height],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const bytesPerRow = alignedBytesPerRow(width, 4);
    const target: ReadbackTarget = {
      texture,
      view: texture.createView(),
      buffer: this.device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      width,
      height,
      bytesPerRow,
    };
    if (kind === "tile") {
      this.tileTarget = target;
    } else {
      this.rawTarget = target;
    }
    return target;
  }

  // Copies the top-left width×height of a target into its buffer and maps it.
  // The caller unmaps the buffer once it has copied what it needs. Awaiting
  // the map is also what waits for the GPU to finish the draw.
  private async readBack(
    target: ReadbackTarget,
    width: number,
    height: number,
  ): Promise<Uint8Array> {
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: target.texture },
      { buffer: target.buffer, bytesPerRow: target.bytesPerRow },
      [width, height],
    );
    this.device.queue.submit([encoder.finish()]);
    await target.buffer.mapAsync(GPUMapMode.READ);
    return new Uint8Array(target.buffer.getMappedRange());
  }
}
