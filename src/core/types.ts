// Types partagés entre le cœur (caméra, math) et les backends de rendu.
// Le but : un backend (WebGPU, WebGL2) ne dépend que de ces types, jamais de
// l'autre backend ni des détails de la caméra.

import type { Dd } from "./doubleDouble";

// Instantané de la caméra + paramètres pour UNE frame.
// C'est de la donnée pure : chaque backend en dérive ce dont il a besoin
// (WebGPU calcule une orbite de référence, WebGL2 découpe le centre en hi/lo).
export type ViewState = {
  // Centre de la vue dans le plan complexe, en double-double (deep zoom).
  centerX: Dd;
  centerY: Dd;

  // Taille verticale visible dans le plan complexe (float64).
  // Plus scale est petit, plus on est zoomé.
  scale: number;

  // Paramètre c de l'ensemble de Julia (constant pour toute l'image).
  cx: number;
  cy: number;

  // Nombre maximum d'itérations pour cette frame.
  maxIter: number;
};

// Ce qu'un rendu renvoie, pour l'overlay de statistiques.
export type RenderInfo = {
  // Temps CPU passé à préparer/soumettre la frame, en millisecondes.
  cpuMs: number;

  // Longueur d'orbite de référence réellement utilisée.
  // 0 si le backend n'utilise pas la perturbation (ex : WebGL2 fallback).
  refLength: number;
};

// Interface commune à tous les backends de rendu.
// main.ts choisit une implémentation et ne parle qu'à cette interface.
export interface Renderer {
  // Nom lisible affiché dans l'overlay (ex : "WebGPU", "WebGL2").
  readonly name: string;

  // Dessine une frame pour l'état de vue donné.
  render(view: ViewState): RenderInfo;

  // Réajuste la taille interne du canvas à la taille affichée.
  resize(): void;
}
