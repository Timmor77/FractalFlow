// Backend de rendu WebGL2 (FALLBACK).
//
// Utilisé uniquement quand WebGPU n'est pas disponible (Safari/iOS anciens,
// vieux GPU). Il itère z = z² + c directement dans le fragment shader avec une
// arithmétique "double-single" (chaque nombre = vec2(hi, lo)). Pas de
// perturbation ici : c'est plus simple et ça marche partout, mais le zoom
// plafonne autour de 1e-14. La version WebGPU va bien plus loin.

import type { Renderer, ViewState, RenderInfo } from "../../core/types";
import { ddToNumber } from "../../core/doubleDouble";
import { MAX_ITER_LIMIT } from "../../core/config";

// Découpe un float64 en float32 hi + reste lo (représentation double-single).
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

// Fragment shader : Julia en arithmétique double-single (vec2 hi/lo).
const fragmentShaderSource = `#version 300 es
precision highp float;

uniform vec2 u_resolution;
uniform vec2 u_centerHigh; // (centerX.hi, centerY.hi)
uniform vec2 u_centerLow;  // (centerX.lo, centerY.lo)
uniform vec2 u_scaleDS;    // (scale.hi, scale.lo)
uniform vec2 u_cHigh;      // (cx.hi, cy.hi)
uniform vec2 u_cLow;       // (cx.lo, cy.lo)
uniform int u_maxIter;

out vec4 outColor;

// --- Primitives double-single (a = vec2(hi, lo)) ---
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
  float t = 4097.0 * a; // 2^12 + 1, adapté aux mantisses 24 bits
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

vec3 palette(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + t));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 p = uv - 0.5;
  p.x *= u_resolution.x / u_resolution.y;

  // Offset écran -> plan complexe, en double-single.
  vec2 offsetX = dsMulFloat(u_scaleDS, p.x);
  vec2 offsetY = dsMulFloat(u_scaleDS, p.y);

  vec2 zRe = dsAdd(vec2(u_centerHigh.x, u_centerLow.x), offsetX);
  vec2 zIm = dsAdd(vec2(u_centerHigh.y, u_centerLow.y), offsetY);

  vec2 cRe = vec2(u_cHigh.x, u_cLow.x);
  vec2 cIm = vec2(u_cHigh.y, u_cLow.y);

  int iter = 0;
  float mag2 = 0.0;
  bool escaped = false;

  // Borne constante requise par WebGL2, strictement > MAX_ITER_LIMIT (TypeScript).
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

  // Coloration lissée, cohérente avec le backend WebGPU.
  float nu = log2(0.5 * log2(mag2));
  float smoothIter = float(iter) + 1.0 - nu;
  outColor = vec4(palette(smoothIter * 0.02), 1.0);
}
`;

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Échec de création du shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Compilation du shader échouée:\n${log}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vs = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Échec de création du programme WebGL");
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Édition de liens échouée:\n${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

function getUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (location === null) {
    throw new Error(`Uniform introuvable: ${name}`);
  }
  return location;
}

export class WebGLRenderer implements Renderer {
  public readonly name = "WebGL2";

  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;

  private readonly u: {
    resolution: WebGLUniformLocation;
    centerHigh: WebGLUniformLocation;
    centerLow: WebGLUniformLocation;
    scaleDS: WebGLUniformLocation;
    cHigh: WebGLUniformLocation;
    cLow: WebGLUniformLocation;
    maxIter: WebGLUniformLocation;
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const gl = canvas.getContext("webgl2");
    if (!gl) {
      throw new Error("WebGL2 non supporté par ce navigateur");
    }
    this.gl = gl;
    this.program = createProgram(gl);

    // Deux triangles plein écran.
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
    };

    // Garde-fou : la borne du shader (4096) doit rester > au plafond d'itérations.
    if (MAX_ITER_LIMIT >= 4096) {
      throw new Error("La borne de boucle du shader WebGL2 (4096) est trop basse");
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
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    return { cpuMs: performance.now() - start, refLength: 0 };
  }

  public resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }
}
