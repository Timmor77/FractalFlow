// Types partagés entre le cœur (caméra, math) et les backends de rendu.
// Le but : un backend (WebGPU, WebGL2) ne dépend que de ces types, jamais de
// l'autre backend ni des détails de la caméra.

import type { Dd } from "./doubleDouble";

// Coefficients d'une palette cosinus : couleur(t) = a + b·cos(2π·(c·t + d)).
// Donnée pure, résolue par main.ts depuis ui/palettes.ts : les backends ne
// dépendent ainsi jamais de l'interface, juste de ces quatre triplets RGB.
export type PaletteCoeffs = {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  d: [number, number, number];
};

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

  // Palette de couleurs à utiliser (coefficients résolus par main.ts).
  palette: PaletteCoeffs;
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

  // Réajuste la taille interne du canvas. qualityScale < 1 réduit la résolution
  // (rendu rapide pendant l'interaction) ; 1 = pleine résolution.
  resize(qualityScale?: number): void;

  // Rend la vue hors écran à la taille demandée (pleine qualité) et renvoie
  // l'image en PNG. Sert au « save image » : on peut viser bien plus grand que
  // l'écran. Le canvas est restauré à sa taille d'affichage juste après.
  capture(view: ViewState, width: number, height: number): Promise<Blob>;
}
