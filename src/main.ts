// Point d'entrée de l'application.
//
// Rôle : créer le canvas, choisir le backend de rendu (WebGPU si possible, sinon
// WebGL2), câbler les contrôles et le panneau (palettes / choix de c / export),
// jouer une courte intro, et redessiner uniquement quand la vue change.

import "./style.css";

import { Viewport } from "./core/viewport";
import { attachControls } from "./controls/controls";
import { StatsOverlay } from "./ui/stats";
import { createControlPanel } from "./ui/panel";
import { PALETTES, DEFAULT_PALETTE, buildPaletteLut } from "./ui/palettes";
import type { Renderer, ViewState } from "./core/types";
import {
  DEFAULT_C,
  adaptiveMaxIter,
  INTERACTIVE_RES_SCALE,
  IDLE_DELAY_MS,
  EXPORT_MAX_SIDE,
  INTRO_DURATION_MS,
  INTRO_START_SCALE,
} from "./core/config";
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

// État piloté par l'interface (le renderer n'en sait rien, il reçoit un ViewState).
const currentC = { x: DEFAULT_C.x, y: DEFAULT_C.y }; // paramètre c (choisi sur la carte)
let paletteIndex = DEFAULT_PALETTE; // palette de couleurs choisie

// LUT de chaque palette, construites une fois (références stables : le backend
// ne ré-upload la texture qu'au changement de palette).
const paletteLuts = PALETTES.map((palette) => buildPaletteLut(palette));

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

// Pendant une interaction (zoom/pan), on rend en résolution réduite pour rester
// fluide ; une passe pleine résolution suit dès que l'input s'arrête.
let interacting = false;

// Pendant un export PNG, le canvas est temporairement redimensionné en grand :
// on gèle les autres rendus pour ne pas relire un canvas à la mauvaise taille.
let capturing = false;

// Petit calcul de FPS (moyenne glissante) pour l'overlay.
let lastRenderTime = 0;
let fps = 0;

// Construit l'état de vue de la frame à partir de la caméra + état UI.
// Les itérations restent complètes même en interaction (sinon zones noires).
function buildView(): ViewState {
  return {
    centerX: viewport.centerX,
    centerY: viewport.centerY,
    scale: viewport.scale,
    cx: currentC.x,
    cy: currentC.y,
    maxIter: adaptiveMaxIter(viewport.getZoomLevel()),
    paletteLut: paletteLuts[paletteIndex],
  };
}

function render(): void {
  if (capturing) {
    return; // l'export pilote lui-même le rendu à ce moment
  }
  renderer.resize(interacting ? INTERACTIVE_RES_SCALE : 1);
  const view = buildView();
  const info = renderer.render(view);

  // FPS : uniquement entre deux frames rapprochées (rendu à la demande sinon).
  const now = performance.now();
  if (lastRenderTime > 0) {
    const dt = now - lastRenderTime;
    if (dt > 0 && dt < 500) {
      fps = fps > 0 ? fps * 0.8 + (1000 / dt) * 0.2 : 1000 / dt;
    }
  }
  lastRenderTime = now;

  renderCount += 1;
  stats.update({
    backend: renderer.name,
    renderCount,
    lastRenderMs: info.cpuMs,
    fps,
    refLength: info.refLength,
    centerX: viewport.getCenterXNumber(),
    centerY: viewport.getCenterYNumber(),
    scale: viewport.scale,
    zoomLevel: viewport.getZoomLevel(),
    maxIter: view.maxIter,
    atMaxDepth: viewport.isAtMaxDepth(),
  });
}

// Planifie un rendu à la prochaine frame (coalesce plusieurs demandes en une).
function scheduleFrame(): void {
  if (frameId !== null || capturing) {
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

// --- Export PNG pleine qualité ---
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function saveImage(): Promise<void> {
  if (capturing) {
    return;
  }
  capturing = true;
  panel.setSaving(true);

  // Annule un rendu en attente : le canvas va être redimensionné pour l'export.
  if (frameId !== null) {
    cancelAnimationFrame(frameId);
    frameId = null;
  }

  try {
    // Taille cible : côté le plus long = EXPORT_MAX_SIDE, en gardant l'aspect écran.
    const aspect = canvas.clientWidth / canvas.clientHeight;
    let width = EXPORT_MAX_SIDE;
    let height = EXPORT_MAX_SIDE;
    if (aspect >= 1) {
      height = Math.round(EXPORT_MAX_SIDE / aspect);
    } else {
      width = Math.round(EXPORT_MAX_SIDE * aspect);
    }

    const blob = await renderer.capture(buildView(), width, height);
    downloadBlob(blob, `fractalflow-${Date.now()}.png`);
  } catch (error) {
    console.error("Échec de l'export de l'image :", error);
  } finally {
    capturing = false;
    panel.setSaving(false);
  }
}

// --- Panneau de contrôle (palettes, carte de c, export, reset) ---
const panel = createControlPanel({
  initialPalette: paletteIndex,
  initialC: currentC,
  onSelectPalette: (index) => {
    paletteIndex = index;
    requestRender();
  },
  onPickC: (cx, cy) => {
    currentC.x = cx;
    currentC.y = cy;
    requestRender();
  },
  onSave: () => {
    void saveImage();
  },
  onReset: () => {
    viewport.reset();
    requestRender();
  },
});
document.body.appendChild(panel.element);

// --- Animation d'intro : la vue rejoint doucement le zoom par défaut ---
function runIntro(): void {
  const targetScale = viewport.scale; // vue par défaut (3.0)
  const startScale = INTRO_START_SCALE;
  const t0 = performance.now();
  let cancelled = false;

  // La moindre interaction saute directement à la vue finale.
  const cancel = (): void => {
    cancelled = true;
  };
  window.addEventListener("pointerdown", cancel, { once: true });
  window.addEventListener("wheel", cancel, { once: true, passive: true });
  window.addEventListener("keydown", cancel, { once: true });

  const step = (now: number): void => {
    if (cancelled) {
      viewport.scale = targetScale;
      render();
      return;
    }
    const p = Math.min(1, (now - t0) / INTRO_DURATION_MS);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
    viewport.scale = startScale + (targetScale - startScale) * eased;
    render();
    if (p < 1) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}

// --- Indicateur « limite de zoom atteinte » ---
// Quand on pousse le zoom au-delà de la profondeur max, l'image ne change plus :
// on ne recalcule rien (voir controls) et on affiche un court message.
const zoomToast = document.createElement("div");
zoomToast.className = "zoom-toast";
zoomToast.textContent = "Profondeur maximale atteinte";
document.body.appendChild(zoomToast);
let toastTimer: number | null = null;
function showZoomLimit(): void {
  zoomToast.classList.add("visible");
  if (toastTimer !== null) {
    clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    zoomToast.classList.remove("visible");
    toastTimer = null;
  }, 1400);
}

// --- Câblage final ---
attachControls(canvas, viewport, requestRender, showZoomLimit);
window.addEventListener("resize", requestRender);

// Raccourci : S pour enregistrer l'image.
window.addEventListener("keydown", (event) => {
  if (event.key === "s" || event.key === "S") {
    void saveImage();
  }
});

runIntro();
