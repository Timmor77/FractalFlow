// c picker using a mini Mandelbrot map.
//
// Every point c of the complex plane corresponds to one Julia set. The
// Mandelbrot map is precisely the "atlas" of all those c: we draw it small and
// the user drags a marker on it to pick the c of the Julia fractal displayed
// full-screen. Same principle as on icefractal.
//
// The Mandelbrot is rendered once (static image, fixed view) with a small
// WebGL2 context independent from the main backend. If WebGL2 is missing, the
// map stays empty but picking a c still works (marker and mapping remain).

// Complex domain shown by the map (covers the whole set). Its width/height
// ratio must match the canvas's to avoid any distortion.
const RE_MIN = -2.38;
const RE_MAX = 0.98;
const IM_MIN = -1.4;
const IM_MAX = 1.4;

// Map display size in CSS pixels (aspect = 3.36 / 2.8 = 1.2).
const MAP_W = 240;
const MAP_H = 200;

const vertexSrc = `#version 300 es
precision highp float;
in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

// Classic Mandelbrot, subtle blue-ish colouring (the marker must stand out).
const fragmentSrc = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform vec4 u_domain; // (reMin, reMax, imMin, imMax)
out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution; // (0,0) at bottom-left
  float cr = mix(u_domain.x, u_domain.y, uv.x);
  float ci = mix(u_domain.z, u_domain.w, uv.y);

  vec2 z = vec2(0.0);
  float m2 = 0.0;
  int iter = 0;
  bool escaped = false;
  for (int i = 0; i < 120; i++) {
    z = vec2(z.x * z.x - z.y * z.y + cr, 2.0 * z.x * z.y + ci);
    m2 = dot(z, z);
    if (m2 > 4.0) { iter = i; escaped = true; break; }
  }

  if (!escaped) {
    outColor = vec4(0.04, 0.05, 0.08, 1.0); // interior: near-black blue
    return;
  }
  float sm = (float(iter) + 1.0 - log2(0.5 * log2(m2))) / 120.0;
  vec3 col = mix(vec3(0.05, 0.10, 0.20), vec3(0.45, 0.65, 0.95), sqrt(sm));
  outColor = vec4(col, 1.0);
}
`;

export type MandelbrotPicker = {
  // Root element to insert into the DOM.
  element: HTMLElement;

  // Repositions the marker (without triggering onChange). For the initial state.
  setC(cx: number, cy: number): void;
};

// Draws the map once into its canvas (static).
function renderMap(canvas: HTMLCanvasElement): void {
  const gl = canvas.getContext("webgl2");
  if (!gl) {
    return; // no WebGL2: empty map, but picking still works
  }

  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSrc));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSrc));
  gl.linkProgram(program);
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), canvas.width, canvas.height);
  gl.uniform4f(gl.getUniformLocation(program, "u_domain"), RE_MIN, RE_MAX, IM_MIN, IM_MAX);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

export function createMandelbrotPicker(
  onChange: (cx: number, cy: number) => void,
): MandelbrotPicker {
  const element = document.createElement("div");
  element.className = "mandelbrot-picker";
  element.style.width = `${MAP_W}px`;
  element.style.height = `${MAP_H}px`;

  const canvas = document.createElement("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(MAP_W * dpr);
  canvas.height = Math.floor(MAP_H * dpr);
  canvas.style.width = `${MAP_W}px`;
  canvas.style.height = `${MAP_H}px`;
  element.appendChild(canvas);

  const marker = document.createElement("div");
  marker.className = "mandelbrot-marker";
  element.appendChild(marker);

  renderMap(canvas);

  // Pixel (inside the map) -> complex point c.
  const pixelToC = (px: number, py: number): [number, number] => {
    const cx = RE_MIN + (px / MAP_W) * (RE_MAX - RE_MIN);
    const cy = IM_MAX - (py / MAP_H) * (IM_MAX - IM_MIN); // screen y is inverted
    return [cx, cy];
  };

  // Repositions the marker from a c value (clamped to the map: a c typed
  // out of range simply sticks to the edge).
  const placeMarker = (cx: number, cy: number): void => {
    const px = ((cx - RE_MIN) / (RE_MAX - RE_MIN)) * MAP_W;
    const py = ((IM_MAX - cy) / (IM_MAX - IM_MIN)) * MAP_H;
    marker.style.left = `${Math.max(0, Math.min(MAP_W, px))}px`;
    marker.style.top = `${Math.max(0, Math.min(MAP_H, py))}px`;
  };

  // Translates a pointer event into a c value, clamped to the map.
  const emitFromEvent = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const px = Math.max(0, Math.min(MAP_W, event.clientX - rect.left));
    const py = Math.max(0, Math.min(MAP_H, event.clientY - rect.top));
    const [cx, cy] = pixelToC(px, py);
    placeMarker(cx, cy);
    onChange(cx, cy);
  };

  let dragging = false;
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    emitFromEvent(event);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (dragging) {
      emitFromEvent(event);
    }
  });
  const stop = (event: PointerEvent): void => {
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);

  return {
    element,
    setC: placeMarker,
  };
}
