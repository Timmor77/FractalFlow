// Point d'entrée de l'application.
//
// Rôle : créer le canvas, choisir le backend de rendu (WebGPU si possible, sinon
// WebGL2), câbler les contrôles, et redessiner uniquement quand la vue change.

import "./style.css";

import { Viewport } from "./core/viewport";
import { attachControls } from "./controls/controls";
import { StatsOverlay } from "./ui/stats";
import type { Renderer, ViewState } from "./core/types";
import { DEFAULT_C, adaptiveMaxIter } from "./core/config";
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
let renderCount = 0;

// Construit l'état de vue de la frame à partir de la caméra + config.
function buildView(): ViewState {
  return {
    centerX: viewport.centerX,
    centerY: viewport.centerY,
    scale: viewport.scale,
    cx: DEFAULT_C.x,
    cy: DEFAULT_C.y,
    maxIter: adaptiveMaxIter(viewport.getZoomLevel()),
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

// Coalesce plusieurs demandes en un seul rendu à la prochaine frame.
function requestRender(): void {
  if (frameId !== null) {
    return;
  }
  frameId = requestAnimationFrame(() => {
    frameId = null;
    render();
  });
}

attachControls(canvas, viewport, requestRender);
window.addEventListener("resize", requestRender);
requestRender();
