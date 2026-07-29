// WebGL2 render backend (COMPATIBILITY FALLBACK).
//
// Used only when WebGPU is unavailable (older Safari/iOS, old GPUs). It
// iterates z = z² + c directly in the fragment shader with "double-single"
// arithmetic (each number = vec2(hi, lo)) — no perturbation, no reference
// orbit. Simple and portable, but shallow: the representation tops out near a
// view scale of 1e-14, and only on drivers that compile the compensated sums as
// written. The constructor probes for that (see probe.frag.glsl) and lowers the
// zoom floor to plain-f32 territory when the probe fails, so the camera never
// pretends to a depth this backend cannot render.
//
// This path is a compatibility preview, not part of the validated deep-zoom
// pipeline: its output is not in the release validation matrix and its timings
// are not reported as benchmark evidence.

import type { Renderer, ViewState, RenderInfo } from "../../core/types";
import { ddToNumber } from "../../core/doubleDouble";
import { canvasToPng } from "../../core/image";
import { MAX_ITER_LIMIT, MAX_DPR } from "../../core/config";
import vertexShaderSource from "./julia.vert.glsl?raw";
import fragmentShaderSource from "./julia.frag.glsl?raw";
import probeShaderSource from "./probe.frag.glsl?raw";

// Zoom floor when the driver keeps the error-free transformations: the
// double-single representation itself dies around 1e-14, so stop just above it.
const DS_MIN_SCALE = 1e-13;

// Zoom floor when the probe shows the compensated arithmetic was optimised
// away: the shader is then effectively plain f32, whose ~1e-7 spacing around
// |z| = 1 stops separating pixels a little below 1e-4.
const F32_MIN_SCALE = 1e-4;

// Splits a float64 into float32 hi + remainder lo (double-single representation).
function splitNumber(value: number): { high: number; low: number } {
  const high = Math.fround(value);
  return { high, low: value - high };
}


function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Failed to create shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed:\n${log}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram {
  const vs = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Failed to create WebGL program");
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program linking failed:\n${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

function getUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (location === null) {
    throw new Error(`Uniform not found: ${name}`);
  }
  return location;
}

// Runs probe.frag.glsl on a 1×1 target: true when the driver preserves the
// rounding residual of twoSum, false when it compiles the compensated sum away.
// A driver that fails this cannot render the deep views the double-single
// coordinates promise, so the caller lowers the zoom floor instead of producing
// a plausible-looking wrong image. Called once, at construction.
function probeCompensatedArithmetic(gl: WebGL2RenderingContext): boolean {
  const program = createProgram(gl, probeShaderSource);
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      return true; // cannot probe: keep the representation's own limit
    }

    // The vertex buffer and VAO of the caller are still bound; the probe program
    // needs its own attribute binding because the location may differ.
    const positionLocation = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.viewport(0, 0, 1, 1);
    gl.useProgram(program);
    // 1 + 1e-8 rounds back to 1 in f32, so the whole information is in the
    // residual. Passed as a uniform to defeat constant folding.
    gl.uniform2f(getUniform(gl, program, "u_probe"), 1.0, 1e-8);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return pixel[0] > 128;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    gl.deleteProgram(program);
  }
}

export class WebGLRenderer implements Renderer {
  public readonly name = "WebGL2";

  // Zoom floor, decided by the start-up probe: the double-single limit when the
  // driver keeps the compensated arithmetic, the plain-f32 limit when it does
  // not. Never 1e-28 — that is the WebGPU perturbation path.
  public readonly minScale: number;

  // Probe result, surfaced for the benchmark page and the UI message.
  public readonly compensatedArithmetic: boolean;

  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly lutTexture: WebGLTexture;

  // Last uploaded palette LUT: we only re-upload on change.
  private lastLut: Uint8Array | null = null;

  private readonly u: {
    resolution: WebGLUniformLocation;
    centerHigh: WebGLUniformLocation;
    centerLow: WebGLUniformLocation;
    scaleDS: WebGLUniformLocation;
    cHigh: WebGLUniformLocation;
    cLow: WebGLUniformLocation;
    maxIter: WebGLUniformLocation;
    lut: WebGLUniformLocation;
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    // preserveDrawingBuffer: required so toBlob (save image) can read back the
    // drawn content afterwards. Negligible cost for a fractal viewer.
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
    if (!gl) {
      throw new Error("WebGL2 is not supported by this browser");
    }
    this.gl = gl;
    this.program = createProgram(gl, fragmentShaderSource);

    // Two fullscreen triangles.
    const positionLocation = gl.getAttribLocation(this.program, "a_position");
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    this.u = {
      resolution: getUniform(gl, this.program, "u_resolution"),
      centerHigh: getUniform(gl, this.program, "u_centerHigh"),
      centerLow: getUniform(gl, this.program, "u_centerLow"),
      scaleDS: getUniform(gl, this.program, "u_scaleDS"),
      cHigh: getUniform(gl, this.program, "u_cHigh"),
      cLow: getUniform(gl, this.program, "u_cLow"),
      maxIter: getUniform(gl, this.program, "u_maxIter"),
      lut: getUniform(gl, this.program, "u_lut"),
    };

    // Palette texture (256×1): horizontal wrap + linear filtering.
    this.lutTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Safety check: the shader loop bound (4096) must stay > the iteration cap.
    if (MAX_ITER_LIMIT >= 4096) {
      throw new Error("The WebGL2 shader loop bound (4096) is too low");
    }

    // Ask the driver what its compiler actually kept, then set the zoom floor
    // to a depth this backend can really render.
    this.compensatedArithmetic = probeCompensatedArithmetic(gl);
    this.minScale = this.compensatedArithmetic ? DS_MIN_SCALE : F32_MIN_SCALE;
    if (!this.compensatedArithmetic) {
      console.warn(
        "WebGL2: this driver optimises the compensated (double-single) arithmetic away; " +
          `zoom limited to ${F32_MIN_SCALE.toExponential(0)} instead of ${DS_MIN_SCALE.toExponential(0)}.`,
      );
    }

    this.resize();
  }

  public render(view: ViewState): RenderInfo {
    const start = performance.now();
    const gl = this.gl;

    const cx = splitNumber(ddToNumber(view.centerX));
    const cy = splitNumber(ddToNumber(view.centerY));
    const sc = splitNumber(view.scale);
    const cRe = splitNumber(view.cx);
    const cIm = splitNumber(view.cy);

    gl.useProgram(this.program);
    gl.uniform2f(this.u.resolution, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.u.centerHigh, cx.high, cy.high);
    gl.uniform2f(this.u.centerLow, cx.low, cy.low);
    gl.uniform2f(this.u.scaleDS, sc.high, sc.low);
    gl.uniform2f(this.u.cHigh, cRe.high, cIm.high);
    gl.uniform2f(this.u.cLow, cRe.low, cIm.low);
    gl.uniform1i(this.u.maxIter, view.maxIter);

    // Palette: upload the LUT only when it changed, then bind on unit 0.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    if (view.paletteLut !== this.lastLut) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, view.paletteLut.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, view.paletteLut);
      this.lastLut = view.paletteLut;
    }
    gl.uniform1i(this.u.lut, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    return { cpuMs: performance.now() - start, refLength: 0 };
  }

  // --- Benchmark harness helpers ---

  // Sets an exact backing-store size, bypassing the clientWidth·DPR logic of
  // resize(). Used to benchmark at a fixed resolution (e.g. 1920×1080).
  public setExactSize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  // Blocks until all submitted GL work has completed (frame timing).
  // gl.finish() alone is not reliably blocking under ANGLE/D3D11, so a 1×1
  // readPixels is used as well: it forces a full pipeline sync for a
  // negligible transfer cost.
  public finish(): void {
    const gl = this.gl;
    gl.finish();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncPixel);
  }

  private readonly syncPixel = new Uint8Array(4);

  // Mean luma of the current framebuffer (sanity check: a silently-black
  // output would invalidate the benchmark numbers). Forces a sync — keep it
  // out of timed sections.
  public sampleMeanLuma(): number {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let sum = 0;
    let count = 0;
    // Sparse sampling is plenty for a mean.
    for (let i = 0; i < pixels.length; i += 4 * 61) {
      sum += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      count++;
    }
    return count > 0 ? sum / count : 0;
  }

  public resize(qualityScale = 1): void {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr * qualityScale));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr * qualityScale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  // Full-quality export: grow the backing store, draw, read the PNG, then
  // restore the display size. Clamped to the GPU's max texture size (keeping
  // aspect) so it can never fail silently.
  public async capture(view: ViewState, width: number, height: number): Promise<Blob> {
    const max = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
    const scale = Math.min(1, max / Math.max(width, height));
    const w = Math.max(1, Math.floor(width * scale));
    const h = Math.max(1, Math.floor(height * scale));
    this.canvas.width = w;
    this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
    this.render(view);
    const blob = await canvasToPng(this.canvas);
    this.resize();
    this.render(view); // leave a sharp frame on screen after the export
    return blob;
  }
}
