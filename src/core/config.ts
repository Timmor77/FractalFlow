// Constantes partagées par l'orchestrateur (main.ts) et les backends.
// Regroupées ici pour éviter les nombres magiques éparpillés.

// Paramètre c par défaut de l'ensemble de Julia.
export const DEFAULT_C = { x: -0.8, y: 0.156 };

// Nombre d'itérations de base (vue dézoomée).
export const BASE_MAX_ITER = 300;

// Plafond dur d'itérations. Borne aussi la taille de l'orbite de référence
// (donc le buffer GPU). 4000 suffit largement pour le zoom visé.
export const MAX_ITER_LIMIT = 4000;

// Itérations ajoutées par niveau de zoom (1 niveau = ×2). Plus on zoome, plus il
// faut d'itérations pour distinguer la structure.
const ITER_PER_ZOOM_LEVEL = 45;

// Calcule le nombre d'itérations adapté au zoom courant.
export function adaptiveMaxIter(zoomLevel: number): number {
  const extra = Math.floor(zoomLevel * ITER_PER_ZOOM_LEVEL);
  return Math.min(BASE_MAX_ITER + extra, MAX_ITER_LIMIT);
}

// --- Rendu adaptatif : rester fluide pendant l'interaction ---
// Le coût GPU croît avec (pixels × itérations). Pendant un zoom/pan on réduit la
// RÉSOLUTION (moins de pixels), mais chaque pixel garde TOUTES ses itérations.
// C'est important : plafonner les itérations laisserait en noir les zones pas
// encore échappées. En réduisant la résolution, chaque pixel est calculé à fond
// → couleurs correctes, juste plus flou. Une passe pleine résolution suit dès
// que l'input s'arrête.

// Plafond du devicePixelRatio (le coût croît avec le carré de la résolution).
export const MAX_DPR = 2;

// Facteur de résolution pendant l'interaction (0.5 = 4× moins de pixels, ~4× plus rapide).
export const INTERACTIVE_RES_SCALE = 0.5;

// Délai sans input avant la passe de rendu nette finale (ms).
export const IDLE_DELAY_MS = 160;

// --- Export image ---
// Côté le plus long (px) visé pour l'export PNG « pleine qualité ». Le backend le
// borne ensuite à la taille de texture max du GPU (en gardant l'aspect).
export const EXPORT_MAX_SIDE = 8192;

// --- Animation d'intro ---
// Au chargement, la vue démarre un peu dézoomée puis rejoint la vue par défaut en
// douceur. Purement esthétique ; annulée dès la première interaction.
export const INTRO_DURATION_MS = 1500;
export const INTRO_START_SCALE = 4.0; // la vue par défaut vaut 3.0 (max = 4.0)
