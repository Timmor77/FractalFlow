// WebGL2 render backend (FALLBACK).
//
// Used only when WebGPU is unavailable (older Safari/iOS, old GPUs). It
// iterates z = z² + c directly in the fragment shader with "double-single"
// arithmetic (each number = vec2(hi, lo)). No perturbation here: it is simpler
// and works everywhere, but the zoom tops out around 1e-14. The WebGPU version
// goes much deeper.

import type { Renderer, ViewState, RenderInfo } from "../../core/types";
import { ddToNumber } from "../../core/doubleDouble";
import { canvasToPng } from "../../core/image";
import { MAX_ITER_LIMIT, MAX_DPR } from "../../core/config";

// Splits a float64 into float32 hi + remainder lo (double-single representation).
function splitNumber(value: number): { high: number; low: number } {
  const high = Math.fround(value);
  return { high, low: value - high };
}

const vertexShaderSource = `#version 300 es
precision highp float;
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Fragment shader: Julia in double-single arithmetic (vec2 hi/lo).
const fragmentShaderSource = `#version 300 es
precision highp float;

uniform vec2 u_resolution;
uniform vec2 u_centerHigh; // (centerX.hi, centerY.hi)
uniform vec2 u_centerLow;  // (centerX.lo, centerY.lo)
uniform vec2 u_scaleDS;    // (scale.hi, scale.lo)
uniform vec2 u_cHigh;      // (cx.hi, cy.hi)
uniform vec2 u_cLow;       // (cx.lo, cy.lo)
uniform int u_maxIter;

// Palette colour lookup table (256×1 LUT), sampled by the smooth iteration
// count. Texture in "repeat" mode -> cyclic colouring.
uniform sampler2D u_lut;

out vec4 outColor;

// --- Double-single primitives (a = vec2(hi, lo)) ---
vec2 twoSum(float a, float b) {
  float s = a + b;
  float bb = s - a;
  return vec2(s, (a - (s - bb)) + (b - bb));
}
vec2 quickTwoSum(float a, float b) {
  float s = a + b;
  return vec2(s, b - (s - a));
}
vec2 splitFloat(float a) {
  float t = 4097.0 * a; // 2^12 + 1, suited to 24-bit mantissas
  float hi = t - (t - a);
  return vec2(hi, a - hi);
}
vec2 twoProd(float a, float b) {
  float p = a * b;
  vec2 as = splitFloat(a);
  vec2 bs = splitFloat(b);
  return vec2(p, ((as.x * bs.x - p) + as.x * bs.y + as.y * bs.x) + as.y * bs.y);
}
vec2 dsAdd(vec2 a, vec2 b) {
  vec2 s = twoSum(a.x, b.x);
  return quickTwoSum(s.x, s.y + a.y + b.y);
}
vec2 dsSub(vec2 a, vec2 b) { return dsAdd(a, vec2(-b.x, -b.y)); }
vec2 dsMul(vec2 a, vec2 b) {
  vec2 p = twoProd(a.x, b.x);
  p.y += a.x * b.y + a.y * b.x;
  return quickTwoSum(p.x, p.y);
}
vec2 dsMulFloat(vec2 a, float b) {
  vec2 p = twoProd(a.x, b);
  p.y += a.y * b;
  return quickTwoSum(p.x, p.y);
}
float dsToFloat(vec2 a) { return a.x + a.y; }

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 p = uv - 0.5;
  p.x *= u_resolution.x / u_resolution.y;

  // Screen offset -> complex plane, in double-single.
  vec2 offsetX = dsMulFloat(u_scaleDS, p.x);
  vec2 offsetY = dsMulFloat(u_scaleDS, p.y);

  vec2 zRe = dsAdd(vec2(u_centerHigh.x, u_centerLow.x), offsetX);
  vec2 zIm = dsAdd(vec2(u_centerHigh.y, u_centerLow.y), offsetY);

  vec2 cRe = vec2(u_cHigh.x, u_cLow.x);
  vec2 cIm = vec2(u_cHigh.y, u_cLow.y);

  int iter = 0;
  float mag2 = 0.0;
  bool escaped = false;

  // Constant bound required by WebGL2, strictly > MAX_ITER_LIMIT (TypeScript).
  for (int i = 0; i < 4096; i++) {
    if (i >= u_maxIter) { break; }

    // z² = (x² - y²) + i(2xy)
    vec2 x2 = dsMul(zRe, zRe);
    vec2 y2 = dsMul(zIm, zIm);
    vec2 xy = dsMul(zRe, zIm);
    zRe = dsAdd(dsSub(x2, y2), cRe);
    zIm = dsAdd(dsMulFloat(xy, 2.0), cIm);

    float zr = dsToFloat(zRe);
    float zi = dsToFloat(zIm);
    mag2 = zr * zr + zi * zi;
    if (mag2 > 4.0) { iter = i; escaped = true; break; }
  }

  if (!escaped) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Smooth colouring, consistent with the WebGPU backend (samples the LUT).
  // Log-damped colour density — see julia.wgsl for the rationale.
  float nu = log2(0.5 * log2(mag2));
  float smoothIter = float(iter) + 1.0 - nu;
  float t = 5.545 * log2(1.0 + smoothIter / 400.0);
  outColor = vec4(texture(u_lut, vec2(t, 0.5)).rgb, 1.0);
}
`;

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

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vs = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
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

export class WebGLRenderer implements Renderer {
  public readonly name = "WebGL2";

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
    this.program = createProgram(gl);

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
