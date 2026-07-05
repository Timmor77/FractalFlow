// Backend de rendu WebGPU (version "pour tout le monde", moderne et rapide).
//
// Il calcule l'orbite de référence sur le CPU (haute précision), l'envoie au GPU
// dans un storage buffer, puis dessine un triangle plein écran dont le fragment
// shader itère la perturbation en f32 (voir julia.wgsl).

import type { Renderer, ViewState, RenderInfo } from "../../core/types";
import { computeReferenceOrbit } from "../../core/referenceOrbit";
import { canvasToPng } from "../../core/image";
import { MAX_ITER_LIMIT, MAX_DPR } from "../../core/config";

// Le shader est importé comme texte brut (Vite, ?raw), il reste dans son fichier.
import shaderCode from "./julia.wgsl?raw";

// Taille du bloc d'uniformes (voir struct Uniforms dans le shader).
// En-tête : resolution(8)+scale(4)+aspect(4)+maxIter(4)+refLength(4)+pad(8) = 32.
// Palette : 4 × vec4f alignés sur 16 octets = 64. Total = 96.
const UNIFORM_SIZE = 96;

export class WebGPURenderer implements Renderer {
  public readonly name = "WebGPU";

  private readonly canvas: HTMLCanvasElement;
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly pipeline: GPURenderPipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly orbitBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;

  // Tampon CPU réutilisé pour écrire les uniformes (évite de réallouer par frame).
  private readonly uniformData = new ArrayBuffer(UNIFORM_SIZE);

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

    // Buffer d'orbite dimensionné une fois pour le plafond d'itérations.
    // MAX_ITER_LIMIT points × (x, y) × 4 octets. ~32 Ko : négligeable.
    this.orbitBuffer = device.createBuffer({
      size: MAX_ITER_LIMIT * 2 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.orbitBuffer } },
      ],
    });

    this.resize();
  }

  // Fabrique asynchrone : WebGPU s'initialise de façon asynchrone.
  // Lève une erreur si WebGPU n'est pas disponible (le caller bascule sur WebGL2).
  public static async create(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
    if (!navigator.gpu) {
      throw new Error("WebGPU non supporté par ce navigateur");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("Aucun adaptateur WebGPU disponible");
    }

    const device = await adapter.requestDevice();

    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new Error("Impossible d'obtenir un contexte WebGPU");
    }

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });

    // Compile le shader et vérifie les erreurs AVANT de continuer : une erreur WGSL
    // ne lève pas d'exception synchrone, donc sans ce contrôle un shader cassé
    // donnerait un écran noir silencieux au lieu de basculer sur WebGL2.
    const module = device.createShaderModule({ code: shaderCode });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length > 0) {
      throw new Error(`Compilation du shader WGSL échouée : ${errors[0].message}`);
    }

    return new WebGPURenderer(canvas, device, context, format, module);
  }

  public render(view: ViewState): RenderInfo {
    const start = performance.now();
    const device = this.device;

    // 1) Orbite de référence (CPU, haute précision) -> GPU.
    const orbit = computeReferenceOrbit(
      view.centerX,
      view.centerY,
      view.cx,
      view.cy,
      view.maxIter,
    );
    device.queue.writeBuffer(this.orbitBuffer, 0, orbit.data, 0, orbit.length * 2);

    // 2) Uniformes. En-tête (indices f32 0..5) puis palette (voir struct Uniforms).
    const f = new Float32Array(this.uniformData);
    const uint = new Uint32Array(this.uniformData);
    f[0] = this.canvas.width;
    f[1] = this.canvas.height;
    f[2] = view.scale;
    f[3] = this.canvas.width / this.canvas.height;
    uint[4] = view.maxIter;
    uint[5] = orbit.length;
    // Palette à partir de l'octet 32 (f32 index 8) : 4 vec4f, on ne remplit que xyz.
    const pal = view.palette;
    f[8] = pal.a[0]; f[9] = pal.a[1]; f[10] = pal.a[2];
    f[12] = pal.b[0]; f[13] = pal.b[1]; f[14] = pal.b[2];
    f[16] = pal.c[0]; f[17] = pal.c[1]; f[18] = pal.c[2];
    f[20] = pal.d[0]; f[21] = pal.d[1]; f[22] = pal.d[2];
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    // 3) Passe de rendu : triangle plein écran (3 sommets).
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
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

  // Ajuste la résolution interne du canvas. qualityScale réduit la résolution
  // pendant l'interaction pour rester fluide (DPR plafonné).
  public resize(qualityScale = 1): void {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr * qualityScale));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr * qualityScale));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  // Export pleine qualité : on agrandit le backing store du canvas à la taille
  // demandée (la taille CSS d'affichage ne bouge pas), on dessine une frame, on
  // lit le PNG, puis on restaure la taille d'affichage. On borne à la taille de
  // texture max du GPU (en gardant l'aspect) pour ne jamais échouer silencieusement.
  public async capture(view: ViewState, width: number, height: number): Promise<Blob> {
    const max = this.device.limits.maxTextureDimension2D;
    const scale = Math.min(1, max / Math.max(width, height));
    this.canvas.width = Math.max(1, Math.floor(width * scale));
    this.canvas.height = Math.max(1, Math.floor(height * scale));
    this.render(view);
    const blob = await canvasToPng(this.canvas);
    this.resize();
    this.render(view); // laisse une frame nette à l'écran après l'export
    return blob;
  }
}
