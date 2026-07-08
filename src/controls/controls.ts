// Contrôles utilisateur : molette (zoom), drag / tactile (pan, pinch), clavier (reset).
//
// Ce module traduit les événements pointeur/clavier en opérations sur le Viewport,
// puis demande un nouveau rendu. Il est indépendant du backend : il marche à
// l'identique avec WebGPU ou WebGL2. Les Pointer Events couvrent à la fois la
// souris et le tactile : 1 pointeur = pan, 2 pointeurs = pinch (zoom + pan).

import type { Viewport } from "../core/viewport";

// Vrai si un raccourci clavier doit être ignoré : l'utilisateur est en train de
// taper dans un champ, ou il s'agit d'une combinaison navigateur (Ctrl+S, Ctrl+R...).
export function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return true;
  }
  const target = event.target;
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

// Branche tous les écouteurs d'événements sur le canvas et la fenêtre.
// `requestRender` est appelé quand la vue change (pan/reset). `onWheel` reçoit
// chaque cran de molette et `onPinch` chaque variation d'écart entre deux doigts :
// main pilote le zoom fluide (voir viewport.nudgeZoom / nudgeZoomByFactor).
export function attachControls(
  canvas: HTMLCanvasElement,
  viewport: Viewport,
  requestRender: () => void,
  onWheel: (mouseX: number, mouseY: number, rect: DOMRect, deltaY: number) => void,
  onPinch: (midX: number, midY: number, rect: DOMRect, factor: number) => void,
): void {
  // Zoom molette, centré sur le curseur (délégué à main pour l'inertie).
  canvas.addEventListener("wheel", (event: WheelEvent) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    onWheel(event.clientX, event.clientY, rect, event.deltaY);
  });

  // Pointeurs actifs sur le canvas (souris bouton gauche, doigts, stylet).
  const pointers = new Map<number, { x: number; y: number }>();

  // Milieu et écartement des deux pointeurs (état du pinch en cours).
  const pinchInfo = (): { midX: number; midY: number; dist: number } => {
    const [a, b] = [...pointers.values()];
    return {
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  };

  canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return; // pan à la souris : bouton gauche uniquement
    }
    if (pointers.size >= 2) {
      return; // au-delà de deux doigts, les suivants sont ignorés
    }
    // La capture garantit que le drag continue même en sortant du canvas.
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });

  canvas.addEventListener("pointermove", (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) {
      return;
    }

    if (pointers.size === 2) {
      // Pinch : le milieu des deux doigts déplace la vue, leur écartement zoome.
      const before = pinchInfo();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const after = pinchInfo();

      viewport.panByPixels(
        after.midX - before.midX,
        after.midY - before.midY,
        canvas.clientWidth,
        canvas.clientHeight,
      );
      if (before.dist > 0 && after.dist > 0) {
        // Doigts qui s'écartent => facteur < 1 => zoom avant.
        onPinch(after.midX, after.midY, canvas.getBoundingClientRect(), before.dist / after.dist);
      }
      requestRender();
      return;
    }

    // Un seul pointeur : pan classique.
    const prev = pointers.get(event.pointerId)!;
    viewport.panByPixels(
      event.clientX - prev.x,
      event.clientY - prev.y,
      canvas.clientWidth,
      canvas.clientHeight,
    );
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    requestRender();
  });

  // Fin de drag / pinch (le navigateur libère la capture tout seul).
  const endPointer = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  // Si la fenêtre perd le focus, on annule tout geste en cours.
  window.addEventListener("blur", () => {
    pointers.clear();
  });

  // Touche R : réinitialise la vue.
  window.addEventListener("keydown", (event: KeyboardEvent) => {
    if (shouldIgnoreShortcut(event)) {
      return;
    }
    if (event.key === "r" || event.key === "R") {
      viewport.reset();
      requestRender();
    }
  });
}
