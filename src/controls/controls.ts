// Contrôles utilisateur : molette (zoom), drag (pan), clavier (reset).
//
// Ce module traduit les événements souris/clavier en opérations sur le Viewport,
// puis demande un nouveau rendu. Il est indépendant du backend : il marche à
// l'identique avec WebGPU ou WebGL2.

import type { Viewport } from "../core/viewport";

// Branche tous les écouteurs d'événements sur le canvas et la fenêtre.
// `requestRender` est appelé chaque fois que la vue change. `onZoomBlocked` (si
// fourni) est appelé quand un zoom ne change rien (limite atteinte) : ça évite
// un rendu inutile tout en permettant de prévenir l'utilisateur.
export function attachControls(
  canvas: HTMLCanvasElement,
  viewport: Viewport,
  requestRender: () => void,
  onZoomBlocked?: () => void,
): void {
  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  // Zoom molette, centré sur le curseur.
  canvas.addEventListener("wheel", (event: WheelEvent) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const changed = viewport.zoomAt(event.clientX, event.clientY, rect, event.deltaY);
    if (changed) {
      requestRender();
    } else if (onZoomBlocked) {
      onZoomBlocked();
    }
  });

  // Début du drag (bouton gauche uniquement).
  canvas.addEventListener("mousedown", (event: MouseEvent) => {
    if (event.button !== 0) {
      return;
    }
    isDragging = true;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
  });

  // Déplacement pendant le drag.
  window.addEventListener("mousemove", (event: MouseEvent) => {
    if (!isDragging) {
      return;
    }

    const deltaX = event.clientX - lastMouseX;
    const deltaY = event.clientY - lastMouseY;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;

    viewport.panByPixels(deltaX, deltaY, canvas.clientWidth, canvas.clientHeight);
    requestRender();
  });

  // Fin du drag.
  window.addEventListener("mouseup", () => {
    isDragging = false;
  });

  // Si la fenêtre perd le focus, on annule un drag en cours.
  window.addEventListener("blur", () => {
    isDragging = false;
  });

  // Touche R : réinitialise la vue.
  window.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "r" || event.key === "R") {
      viewport.reset();
      requestRender();
    }
  });
}
