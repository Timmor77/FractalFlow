// Sélecteur de c via une mini-carte de Mandelbrot.
//
// Chaque point c du plan complexe correspond à un ensemble de Julia. La carte de
// Mandelbrot est justement « l'atlas » de tous ces c : on la dessine en petit et
// l'utilisateur déplace un marqueur dessus pour choisir le c de la fractale Julia
// affichée en grand. C'est le même principe que sur icefractal.
//
// Rendu Mandelbrot une seule fois (image statique, vue fixe) via un petit WebGL2
// indépendant du backend principal. Si WebGL2 manque, la carte reste vide mais on
// peut toujours choisir un c (le marqueur et le mapping fonctionnent).

// Domaine complexe affiché par la carte (montre tout l'ensemble). Son ratio
// largeur/hauteur doit coller à celui du canvas pour éviter toute déformation.
const RE_MIN = -2.38;
const RE_MAX = 0.98;
const IM_MIN = -1.4;
const IM_MAX = 1.4;

// Taille d'affichage de la carte en pixels CSS (aspect = 3.36 / 2.8 = 1.2).
const MAP_W = 240;
const MAP_H = 200;

const vertexSrc = `#version 300 es
precision highp float;
in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

// Mandelbrot classique, coloration bleutée discrète (le marqueur doit ressortir).
const fragmentSrc = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform vec4 u_domain; // (reMin, reMax, imMin, imMax)
out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution; // (0,0) en bas à gauche
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
    outColor = vec4(0.04, 0.05, 0.08, 1.0); // intérieur : presque noir bleuté
    return;
  }
  float sm = (float(iter) + 1.0 - log2(0.5 * log2(m2))) / 120.0;
  vec3 col = mix(vec3(0.05, 0.10, 0.20), vec3(0.45, 0.65, 0.95), sqrt(sm));
  outColor = vec4(col, 1.0);
}
`;

export type MandelbrotPicker = {
  // Élément racine à insérer dans le DOM.
  element: HTMLElement;

  // Repositionne le marqueur (sans déclencher onChange). Pour l'état initial.
  setC(cx: number, cy: number): void;
};

// Dessine la carte une fois dans son canvas (statique).
function renderMap(canvas: HTMLCanvasElement): void {
  const gl = canvas.getContext("webgl2");
  if (!gl) {
    return; // pas de WebGL2 : carte vide, mais la sélection reste possible
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

  // Pixel (dans la carte) -> point complexe c.
  const pixelToC = (px: number, py: number): [number, number] => {
    const cx = RE_MIN + (px / MAP_W) * (RE_MAX - RE_MIN);
    const cy = IM_MAX - (py / MAP_H) * (IM_MAX - IM_MIN); // y écran inversé
    return [cx, cy];
  };

  // Repositionne le marqueur à partir d'un c (borné à la carte : un c saisi
  // hors champ colle simplement au bord).
  const placeMarker = (cx: number, cy: number): void => {
    const px = ((cx - RE_MIN) / (RE_MAX - RE_MIN)) * MAP_W;
    const py = ((IM_MAX - cy) / (IM_MAX - IM_MIN)) * MAP_H;
    marker.style.left = `${Math.max(0, Math.min(MAP_W, px))}px`;
    marker.style.top = `${Math.max(0, Math.min(MAP_H, py))}px`;
  };

  // Traduit un événement pointeur en c, borné à la carte.
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
