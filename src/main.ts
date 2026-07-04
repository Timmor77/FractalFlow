// Point d'entrée de l'application.
//
// Rôle : créer le canvas, choisir le backend de rendu (WebGPU si possible, sinon
// WebGL2), câbler les contrôles, et redessiner uniquement quand la vue change.

import "./style.css";

import { Viewport } from "./core/viewport";
import { attachControls } from "./controls/controls";
import { StatsOverlay } from "./ui/stats";
import type { Renderer, ViewState } from "./core/types";
import { DEFAULT_C, adaptiveMaxIter, INTERACTIVE_MAX_ITER, IDLE_DELAY_MS } from "./core/config";
import { WebGPURenderer } from "./backends/webgpu/webgpuRenderer";
import { WebGLRenderer } from "./backends/webgl/webglRenderer";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Élément #app introuvable");
}
app.innerHTML = "";

const canvas = document.createElement("canvas");
canvas.id = "fractal-canvas";
app.appendChild(canvas);

const viewport = new Viewport();
const stats = new StatsOverlay();

// WebGPU d'abord (moderne + deep zoom par perturbation) ; WebGL2 en secours.
async function createRenderer(): Promise<Renderer> {
  try {
    return await WebGPURenderer.create(canvas);
  } catch (error) {
    console.warn("WebGPU indisponible, bascule sur WebGL2 :", error);
    return new WebGLRenderer(canvas);
  }
}

const renderer = await createRenderer();

let frameId: number | null = null;
let idleTimer: number | null = null;
let renderCount = 0;

// Pendant une interaction (zoom/pan), on plafonne les itérations pour rester
// fluide ; une passe nette (toutes itérations) suit dès que l'input s'arrête.
let interacting = false;

// Construit l'état de vue de la frame à partir de la caméra + config.
function buildView(): ViewState {
  const fullIter = adaptiveMaxIter(viewport.getZoomLevel());
  return {
    centerX: viewport.centerX,
    centerY: viewport.centerY,
    scale: viewport.scale,
    cx: DEFAULT_C.x,
    cy: DEFAULT_C.y,
    maxIter: interacting ? Math.min(fullIter, INTERACTIVE_MAX_ITER) : fullIter,
  };
}

function render(): void {
  renderer.resize();
  const view = buildView();
  const info = renderer.render(view);

  renderCount += 1;
  stats.update({
    backend: renderer.name,
    renderCount,
    lastRenderMs: info.cpuMs,
    refLength: info.refLength,
    centerX: viewport.getCenterXNumber(),
    centerY: viewport.getCenterYNumber(),
    scale: viewport.scale,
    zoomLevel: viewport.getZoomLevel(),
    maxIter: view.maxIter,
  });
}

// Planifie un rendu à la prochaine frame (coalesce plusieurs demandes en une).
function scheduleFrame(): void {
  if (frameId !== null) {
    return;
  }
  frameId = requestAnimationFrame(() => {
    frameId = null;
    render();
  });
}

// Appelé à chaque input : rendu rapide immédiat, puis rendu net après un repos.
function requestRender(): void {
  interacting = true;
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
  }
  idleTimer = window.setTimeout(() => {
    idleTimer = null;
    interacting = false;
    scheduleFrame(); // passe nette finale, pleine résolution + itérations complètes
  }, IDLE_DELAY_MS);
  scheduleFrame();
}

attachControls(canvas, viewport, requestRender);
window.addEventListener("resize", requestRender);
requestRender();
