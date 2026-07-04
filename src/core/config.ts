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
