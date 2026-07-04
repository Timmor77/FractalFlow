// Backend de rendu WebGPU (version "pour tout le monde", moderne et rapide).
//
// Il calcule l'orbite de référence sur le CPU (haute précision), l'envoie au GPU
// dans un storage buffer, puis dessine un triangle plein écran dont le fragment
// shader itère la perturbation en f32 (voir julia.wgsl).

import type { Renderer, ViewState, RenderInfo } from "../../core/types";
import { computeReferenceOrbit } from "../../core/referenceOrbit";
import { MAX_ITER_LIMIT, MAX_DPR } from "../../core/config";

// Le shader est importé comme texte brut (Vite, ?raw), il reste dans son fichier.
import shaderCode from "./julia.wgsl?raw";

// Taille du bloc d'uniformes (voir struct Uniforms dans le shader).
// resolution(8) + scale(4) + aspect(4) + maxIter(4) + refLength(4) = 24, arrondi à 32.
const UNIFORM_SIZE = 32;

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

    // 2) Uniformes.
    const f = new Float32Array(this.uniformData);
    const uint = new Uint32Array(this.uniformData);
    f[0] = this.canvas.width;
    f[1] = this.canvas.height;
    f[2] = view.scale;
    f[3] = this.canvas.width / this.canvas.height;
    uint[4] = view.maxIter;
    uint[5] = orbit.length;
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
  // pendant l'interaction pour rester fluide.
  public resize(qualityScale = 1): void {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr * qualityScale));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr * qualityScale));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }
}
