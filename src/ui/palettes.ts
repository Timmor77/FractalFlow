// Palettes de couleurs (source unique de vérité).
//
// Chaque palette suit la formule cosinus d'Inigo Quilez :
//   couleur(t) = a + b · cos(2π · (c·t + d))
// où a, b, c, d sont des triplets RGB. C'est compact, cyclique et toujours doux.
//
// Ces quatre vecteurs sont envoyés tels quels aux shaders (WebGPU et WebGL2) via
// des uniformes : aucun code couleur n'est dupliqué dans les shaders. La même
// formule est réimplémentée ici en JS uniquement pour dessiner les pastilles de
// prévisualisation de l'interface.

export type Palette = {
  // Nom affiché dans l'interface.
  name: string;

  // Les quatre triplets RGB de la formule cosinus.
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  d: [number, number, number];
};

// Jeu de palettes proposé. L'index dans ce tableau est ce que voit le shader.
export const PALETTES: Palette[] = [
  {
    name: "Arc-en-ciel",
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [1.0, 1.0, 1.0],
    d: [0.0, 0.33, 0.67],
  },
  {
    name: "Braise",
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [1.0, 1.0, 1.0],
    d: [0.0, 0.1, 0.2],
  },
  {
    name: "Glace",
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [1.0, 1.0, 1.0],
    d: [0.5, 0.6, 0.75],
  },
  {
    name: "Or",
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [1.0, 1.0, 0.5],
    d: [0.8, 0.9, 0.3],
  },
  {
    name: "Coucher",
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [1.0, 0.7, 0.4],
    d: [0.0, 0.15, 0.2],
  },
  {
    name: "Néon",
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [2.0, 1.0, 0.0],
    d: [0.5, 0.2, 0.25],
  },
];

// Palette par défaut au chargement.
export const DEFAULT_PALETTE = 0;

// Évalue une palette en t (même formule que les shaders) -> RGB dans [0, 255].
// Sert à peindre les pastilles de l'interface pour qu'elles collent au rendu.
export function paletteColor(p: Palette, t: number): [number, number, number] {
  const channel = (i: number): number => {
    const v = p.a[i] + p.b[i] * Math.cos(6.28318 * (p.c[i] * t + p.d[i]));
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  };
  return [channel(0), channel(1), channel(2)];
}

// Construit un dégradé CSS qui échantillonne la palette (pour une pastille d'aperçu).
export function paletteGradientCss(p: Palette, stops = 8): string {
  const parts: string[] = [];
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1);
    const [r, g, b] = paletteColor(p, t);
    parts.push(`rgb(${r}, ${g}, ${b}) ${Math.round(t * 100)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}
