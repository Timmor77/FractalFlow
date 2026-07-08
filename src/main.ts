// Point d'entrée de l'application.
//
// Rôle : créer le canvas, choisir le backend de rendu (WebGPU si possible, sinon
// WebGL2), câbler les contrôles et le panneau (palettes / choix de c / export),
// jouer une courte intro, et redessiner uniquement quand la vue change.

import "./style.css";

import { Viewport } from "./core/viewport";
import { attachControls, shouldIgnoreShortcut } from "./controls/controls";
import { StatsOverlay } from "./ui/stats";
import { createControlPanel } from "./ui/panel";
import { PALETTES, DEFAULT_PALETTE, buildPaletteLut } from "./ui/palettes";
import type { Renderer, ViewState } from "./core/types";
import {
  DEFAULT_C,
  adaptiveMaxIter,
  INTERACTIVE_RES_SCALE,
  INTERACTIVE_RES_MIN,
  INTERACTIVE_RES_MAX,
  FRAME_SLOW_MS,
  FRAME_FAST_MS,
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

let rafId: number | null = null;
let idleTimer: number | null = null;
let renderCount = 0;

// Pendant une interaction (zoom/pan), on rend en résolution réduite pour rester
// fluide ; une passe pleine résolution suit dès que l'input s'arrête.
let interacting = false;

// Zoom fluide en cours : la boucle continue d'animer scale vers sa cible.
let zooming = false;

// Pendant un export PNG, le canvas est temporairement redimensionné en grand :
// on gèle les autres rendus pour ne pas relire un canvas à la mauvaise taille.
let capturing = false;

// Résolution d'interaction adaptative (part de la base, s'ajuste à la cadence).
let interactiveScale = INTERACTIVE_RES_SCALE;

// Cadence : dernier timestamp de frame + FPS lissé pour l'overlay.
let lastFrameTime = 0;
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
  // En mouvement (interaction OU zoom inertiel) : résolution réduite ; sinon nette.
  const moving = interacting || zooming;
  renderer.resize(moving ? interactiveScale : 1);
  const view = buildView();
  const info = renderer.render(view);

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

// Ajuste la résolution d'interaction selon le temps réel par frame : on baisse
// si le GPU n'arrive pas à suivre (frames longues), on remonte s'il a de la
// marge. La zone morte entre les deux seuils évite un « clignotement » de netteté.
function adaptResolution(dt: number): void {
  if (dt > FRAME_SLOW_MS) {
    interactiveScale = Math.max(INTERACTIVE_RES_MIN, interactiveScale * 0.85);
  } else if (dt < FRAME_FAST_MS) {
    interactiveScale = Math.min(INTERACTIVE_RES_MAX, interactiveScale * 1.06);
  }
}

// Boucle de rendu : pendant l'interaction elle tourne à chaque frame d'affichage
// (pan/zoom plus fluides et cadence mesurable) ; sinon elle rend une seule fois
// (la passe nette) puis s'arrête.
function frame(now: number): void {
  rafId = null;

  if (lastFrameTime > 0) {
    const dt = now - lastFrameTime;
    if (dt > 0 && dt < 1000) {
      fps = fps > 0 ? fps * 0.8 + (1000 / dt) * 0.2 : 1000 / dt;
      if (interacting || zooming) {
        adaptResolution(dt);
      }
    }
  }
  lastFrameTime = now;

  // Avance le zoom inertiel : quand il a rejoint sa cible, zooming repasse à false.
  if (zooming) {
    zooming = viewport.advanceZoom();
  }

  render();

  if ((interacting || zooming) && !capturing) {
    rafId = requestAnimationFrame(frame);
  } else {
    lastFrameTime = 0; // repart « à froid » à la prochaine interaction
    updateHash(); // mémorise l'emplacement dans l'URL une fois tout stabilisé
  }
}

// Garantit qu'une frame est planifiée (démarre/relance la boucle).
function scheduleFrame(): void {
  if (rafId === null && !capturing) {
    rafId = requestAnimationFrame(frame);
  }
}

// Appelé à chaque input : lance la boucle d'interaction, puis programme la passe
// nette (pleine résolution) après un court repos sans input.
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
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
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

// --- État partageable via l'URL (#...) ---
// On encode centre (double-double hi_lo, pour rester exact en deep zoom), scale,
// c et palette. Rechargement = même vue ; le bouton « Copier le lien » partage.
function serializeState(): string {
  const params = new URLSearchParams();
  params.set("x", `${viewport.centerX.hi}_${viewport.centerX.lo}`);
  params.set("y", `${viewport.centerY.hi}_${viewport.centerY.lo}`);
  params.set("s", String(viewport.scale));
  params.set("cx", String(currentC.x));
  params.set("cy", String(currentC.y));
  params.set("p", String(paletteIndex));
  return params.toString();
}

function updateHash(): void {
  // replaceState : met à jour l'URL sans empiler d'historique ni faire défiler.
  history.replaceState(null, "", `#${serializeState()}`);
}

function loadStateFromHash(): boolean {
  const raw = location.hash.slice(1);
  if (!raw) {
    return false;
  }
  const p = new URLSearchParams(raw);
  const xs = (p.get("x") ?? "").split("_").map(Number);
  const ys = (p.get("y") ?? "").split("_").map(Number);
  const s = Number(p.get("s"));
  if (
    xs.length !== 2 || ys.length !== 2 ||
    !xs.every(Number.isFinite) || !ys.every(Number.isFinite) || !Number.isFinite(s)
  ) {
    return false;
  }
  viewport.setView({ hi: xs[0], lo: xs[1] }, { hi: ys[0], lo: ys[1] }, s);
  const cx = Number(p.get("cx"));
  const cy = Number(p.get("cy"));
  if (Number.isFinite(cx) && Number.isFinite(cy)) {
    currentC.x = cx;
    currentC.y = cy;
  }
  const pi = Number(p.get("p"));
  if (Number.isFinite(pi) && pi >= 0 && pi < PALETTES.length) {
    paletteIndex = Math.floor(pi);
  }
  return true;
}

async function copyLink(): Promise<void> {
  updateHash(); // garantit que l'URL reflète la vue courante avant de copier
  try {
    await navigator.clipboard.writeText(location.href);
    panel.flashCopied();
  } catch {
    // presse-papiers indisponible : l'URL reste de toute façon dans la barre.
  }
}

// --- Zoom fluide : molette / pinch déplacent une cible, la boucle anime le reste ---
// Le toast « profondeur maximale » n'est montré que si on butte en zoomant VERS
// l'avant : bloqué au dézoom max, on ne dit rien (le message serait trompeur).
function applyZoomResult(result: "zoom" | "blocked", zoomingIn: boolean): void {
  if (result === "blocked") {
    if (zoomingIn) {
      showZoomLimit();
    }
    return;
  }
  zooming = true;
  requestRender();
}

function onWheel(mouseX: number, mouseY: number, rect: DOMRect, deltaY: number): void {
  applyZoomResult(viewport.nudgeZoom(mouseX, mouseY, rect, deltaY), deltaY < 0);
}

// Pinch tactile : deux doigts qui s'écartent => facteur < 1 => zoom avant.
function onPinch(midX: number, midY: number, rect: DOMRect, factor: number): void {
  applyZoomResult(viewport.nudgeZoomByFactor(midX, midY, rect, factor), factor < 1);
}

// Reprise éventuelle d'un emplacement depuis l'URL (avant de construire le panneau).
const restored = loadStateFromHash();

// --- Panneau de contrôle (palettes, carte de c, export, reset, lien) ---
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
  onCopyLink: () => {
    void copyLink();
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
attachControls(canvas, viewport, requestRender, onWheel, onPinch);
window.addEventListener("resize", requestRender);

// Raccourci : S pour enregistrer l'image (ignoré pendant une saisie ou avec Ctrl/Alt).
window.addEventListener("keydown", (event) => {
  if (shouldIgnoreShortcut(event)) {
    return;
  }
  if (event.key === "s" || event.key === "S") {
    void saveImage();
  }
});

// Coller un lien partagé dans la barre d'adresse (ou naviguer dans l'historique)
// recharge la vue correspondante sans rechargement de page.
window.addEventListener("hashchange", () => {
  if (loadStateFromHash()) {
    panel.setC(currentC.x, currentC.y);
    panel.setPalette(paletteIndex);
    requestRender();
  }
});

// Si on reprend un emplacement partagé, on l'affiche directement ; sinon intro.
if (restored) {
  render();
} else {
  runIntro();
}
