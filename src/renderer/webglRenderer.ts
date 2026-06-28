// Viewport gère la caméra : centre, zoom, pan, high/low.
import { Viewport, splitNumber } from "../math/viewport";

// Overlay de stats.
import { StatsOverlay } from "../ui/stats";

// Vertex shader : dessine deux triangles plein écran.
const vertexShaderSource = `#version 300 es

precision highp float;

in vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Fragment shader : calcule l'ensemble de Julia.
// Cette version utilise une arithmétique double-single simple.
// Un nombre est représenté par vec2(hi, lo).
const fragmentShaderSource = `#version 300 es

precision highp float;

uniform vec2 u_resolution;

// Centre high/low.
// u_centerHigh.x = centerX high
// u_centerLow.x  = centerX low
// u_centerHigh.y = centerY high
// u_centerLow.y  = centerY low
uniform vec2 u_centerHigh;
uniform vec2 u_centerLow;

// Scale high/low.
// x = high, y = low.
uniform vec2 u_scaleDS;

// Paramètre c high/low.
uniform vec2 u_cHigh;
uniform vec2 u_cLow;

uniform int u_maxIter;

out vec4 outColor;

// Addition exacte approximée de deux floats.
vec2 twoSum(float a, float b) {
  float s = a + b;
  float bb = s - a;
  float e = (a - (s - bb)) + (b - bb);
  return vec2(s, e);
}

// Addition rapide quand |a| >= |b|.
vec2 quickTwoSum(float a, float b) {
  float s = a + b;
  float e = b - (s - a);
  return vec2(s, e);
}

// Split d'un float pour approximer l'erreur du produit.
// 4097 = 2^12 + 1, adapté aux floats 24 bits de mantisse.
vec2 splitFloat(float a) {
  float t = 4097.0 * a;
  float hi = t - (t - a);
  float lo = a - hi;
  return vec2(hi, lo);
}

// Produit de deux floats avec erreur.
vec2 twoProd(float a, float b) {
  float p = a * b;

  vec2 as = splitFloat(a);
  vec2 bs = splitFloat(b);

  float e = ((as.x * bs.x - p) + as.x * bs.y + as.y * bs.x) + as.y * bs.y;

  return vec2(p, e);
}

// Addition double-single.
// a = vec2(hi, lo)
// b = vec2(hi, lo)
vec2 dsAdd(vec2 a, vec2 b) {
  vec2 s = twoSum(a.x, b.x);
  float e = s.y + a.y + b.y;
  return quickTwoSum(s.x, e);
}

// Soustraction double-single.
vec2 dsSub(vec2 a, vec2 b) {
  return dsAdd(a, vec2(-b.x, -b.y));
}

// Multiplication double-single.
vec2 dsMul(vec2 a, vec2 b) {
  vec2 p = twoProd(a.x, b.x);
  p.y += a.x * b.y + a.y * b.x;
  return quickTwoSum(p.x, p.y);
}

// Multiplication double-single par float.
vec2 dsMulFloat(vec2 a, float b) {
  vec2 p = twoProd(a.x, b);
  p.y += a.y * b;
  return quickTwoSum(p.x, p.y);
}

// Convertit double-single vers float pour les tests/couleurs.
float dsToFloat(vec2 a) {
  return a.x + a.y;
}

// Palette simple.
vec3 palette(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (vec3(0.00, 0.33, 0.67) + t));
}

void main() {
  // Coordonnées écran en pixels.
  vec2 pixel = gl_FragCoord.xy;

  // Normalisation entre 0 et 1.
  vec2 uv = pixel / u_resolution;

  // Recentre autour de 0.
  vec2 p = uv - 0.5;

  // Correction aspect ratio.
  p.x *= u_resolution.x / u_resolution.y;

  // Scale en double-single.
  vec2 scaleDS = u_scaleDS;

  // Offset écran -> complexe, en double-single.
  vec2 offsetX = dsMulFloat(scaleDS, p.x);
  vec2 offsetY = dsMulFloat(scaleDS, p.y);

  // Centre high/low.
  vec2 centerX = vec2(u_centerHigh.x, u_centerLow.x);
  vec2 centerY = vec2(u_centerHigh.y, u_centerLow.y);

  // Coordonnée complexe initiale z = center + offset.
  vec2 zRe = dsAdd(centerX, offsetX);
  vec2 zIm = dsAdd(centerY, offsetY);

  // Paramètre c high/low.
  vec2 cRe = vec2(u_cHigh.x, u_cLow.x);
  vec2 cIm = vec2(u_cHigh.y, u_cLow.y);

  int iter = 0;

  // Limite constante imposée côté shader.
  // u_maxIter doit rester <= 4000 côté TypeScript.
  for (int i = 0; i < 4000; i++) {
    if (i >= u_maxIter) {
      iter = u_maxIter;
      break;
    }

    // z² = (x² - y²) + i(2xy)
    vec2 x2 = dsMul(zRe, zRe);
    vec2 y2 = dsMul(zIm, zIm);
    vec2 xy = dsMul(zRe, zIm);

    vec2 nextRe = dsAdd(dsSub(x2, y2), cRe);
    vec2 nextIm = dsAdd(dsMulFloat(xy, 2.0), cIm);

    zRe = nextRe;
    zIm = nextIm;

    // Test de divergence.
    // On utilise les parties high pour rester rapide.
    float zr = dsToFloat(zRe);
    float zi = dsToFloat(zIm);

    if (zr * zr + zi * zi > 4.0) {
      iter = i;
      break;
    }
  }

  if (iter == u_maxIter) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float t = float(iter) / float(u_maxIter);

  vec3 color = palette(t);

  outColor = vec4(color, 1.0);
}
`;

// Compile un shader GLSL.
function createShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);

  if (!shader) {
    throw new Error("Failed to create shader");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  const success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);

  if (!success) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed:\n${log}`);
  }

  return shader;
}

// Crée le programme GPU complet.
function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

  const program = gl.createProgram();

  if (!program) {
    throw new Error("Failed to create WebGL program");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  const success = gl.getProgramParameter(program, gl.LINK_STATUS);

  if (!success) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program linking failed:\n${log}`);
  }

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  return program;
}

// Récupère un uniform.
function getUniformLocation(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);

  if (location === null) {
    throw new Error(`Uniform not found: ${name}`);
  }

  return location;
}

// Renderer WebGL principal.
export class WebGLRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;

  private readonly resolutionLocation: WebGLUniformLocation;
  private readonly centerHighLocation: WebGLUniformLocation;
  private readonly centerLowLocation: WebGLUniformLocation;
  private readonly scaleDSLocation: WebGLUniformLocation;
  private readonly cHighLocation: WebGLUniformLocation;
  private readonly cLowLocation: WebGLUniformLocation;
  private readonly maxIterLocation: WebGLUniformLocation;

  private readonly viewport = new Viewport();
  private readonly stats = new StatsOverlay();

  private readonly cRe = -0.8;
  private readonly cIm = 0.156;

  private readonly baseMaxIter = 300;
  private readonly maxIterLimit = 3000;

  private isDragging = false;
  private lastMouseX = 0;
  private lastMouseY = 0;

  private animationFrameId: number | null = null;
  private renderCount = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const gl = canvas.getContext("webgl2");

    if (!gl) {
      throw new Error("WebGL2 is not supported by this browser or device");
    }

    this.gl = gl;
    this.program = createProgram(gl);

    const positionLocation = gl.getAttribLocation(this.program, "a_position");

    if (positionLocation === -1) {
      throw new Error("Attribute not found: a_position");
    }

    const positionBuffer = gl.createBuffer();

    if (!positionBuffer) {
      throw new Error("Failed to create position buffer");
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);

    const positions = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,

      -1,  1,
       1, -1,
       1,  1,
    ]);

    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const vao = gl.createVertexArray();

    if (!vao) {
      throw new Error("Failed to create vertex array object");
    }

    this.vao = vao;

    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    this.resolutionLocation = getUniformLocation(gl, this.program, "u_resolution");
    this.centerHighLocation = getUniformLocation(gl, this.program, "u_centerHigh");
    this.centerLowLocation = getUniformLocation(gl, this.program, "u_centerLow");
    this.scaleDSLocation = getUniformLocation(gl, this.program, "u_scaleDS");
    this.cHighLocation = getUniformLocation(gl, this.program, "u_cHigh");
    this.cLowLocation = getUniformLocation(gl, this.program, "u_cLow");
    this.maxIterLocation = getUniformLocation(gl, this.program, "u_maxIter");

    this.setupControls();

    window.addEventListener("resize", () => {
      this.requestRender();
    });
  }

  // Demande un rendu à la prochaine frame.
  public requestRender(): void {
    if (this.animationFrameId !== null) {
      return;
    }

    this.animationFrameId = requestAnimationFrame(() => {
      this.animationFrameId = null;
      this.render();
    });
  }

  // Calcule maxIter selon le zoom.
  private getAdaptiveMaxIter(): number {
    const zoomLevel = this.viewport.getZoomLevel();

    const extraIter = Math.floor(zoomLevel * 45);

    return Math.min(this.baseMaxIter + extraIter, this.maxIterLimit);
  }

  // Configure les contrôles utilisateur.
  private setupControls(): void {
    this.canvas.addEventListener("wheel", (event: WheelEvent) => {
      event.preventDefault();

      const rect = this.canvas.getBoundingClientRect();

      this.viewport.zoomAt(event.clientX, event.clientY, rect, event.deltaY);

      this.requestRender();
    });

    this.canvas.addEventListener("mousedown", (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      this.isDragging = true;
      this.lastMouseX = event.clientX;
      this.lastMouseY = event.clientY;
    });

    window.addEventListener("mousemove", (event: MouseEvent) => {
      if (!this.isDragging) {
        return;
      }

      const deltaX = event.clientX - this.lastMouseX;
      const deltaY = event.clientY - this.lastMouseY;

      this.lastMouseX = event.clientX;
      this.lastMouseY = event.clientY;

      this.viewport.panByPixels(
        deltaX,
        deltaY,
        this.canvas.clientWidth,
        this.canvas.clientHeight,
      );

      this.requestRender();
    });

    window.addEventListener("mouseup", () => {
      this.isDragging = false;
    });

    window.addEventListener("blur", () => {
      this.isDragging = false;
    });

    window.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "r" || event.key === "R") {
        this.viewport.reset();
        this.requestRender();
      }
    });
  }

  // Dessine une frame.
  private render(): void {
    const renderStart = performance.now();

    this.resizeCanvasIfNeeded();

    const gl = this.gl;

    const centerX = this.viewport.getCenterXSplit();
    const centerY = this.viewport.getCenterYSplit();
    const scale = this.viewport.getScaleSplit();

    const cRe = splitNumber(this.cRe);
    const cIm = splitNumber(this.cIm);

    const adaptiveMaxIter = this.getAdaptiveMaxIter();

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.uniform2f(this.resolutionLocation, this.canvas.width, this.canvas.height);

    gl.uniform2f(this.centerHighLocation, centerX.high, centerY.high);
    gl.uniform2f(this.centerLowLocation, centerX.low, centerY.low);

    gl.uniform2f(this.scaleDSLocation, scale.high, scale.low);

    gl.uniform2f(this.cHighLocation, cRe.high, cIm.high);
    gl.uniform2f(this.cLowLocation, cRe.low, cIm.low);

    gl.uniform1i(this.maxIterLocation, adaptiveMaxIter);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const renderEnd = performance.now();

    this.renderCount += 1;

    this.stats.update({
      renderCount: this.renderCount,
      lastRenderMs: renderEnd - renderStart,
      centerX: this.viewport.centerX,
      centerY: this.viewport.centerY,
      scale: this.viewport.scale,
      zoomLevel: this.viewport.getZoomLevel(),
      maxIter: adaptiveMaxIter,
    });
  }

  // Ajuste la résolution interne du canvas.
  private resizeCanvasIfNeeded(): void {
    const pixelRatio = window.devicePixelRatio || 1;

    const width = Math.floor(this.canvas.clientWidth * pixelRatio);
    const height = Math.floor(this.canvas.clientHeight * pixelRatio);

    if (this.canvas.width === width && this.canvas.height === height) {
      return;
    }

    this.canvas.width = width;
    this.canvas.height = height;

    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }
}