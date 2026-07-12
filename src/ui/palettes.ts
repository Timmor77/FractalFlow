// Colour palettes (single source of truth).
//
// A palette is a list of "stops": colours placed at positions t ∈ [0, 1].
// A 256-pixel lookup table (LUT) is built from it, which the shaders sample
// with the smooth iteration count. This is the Ultra Fractal / icefractal
// approach: it faithfully renders multi-hue gradients (blue → white → gold)
// that a simple sinusoid cannot produce.
//
// The first and last colours are identical: the palette loops smoothly
// (the sampler is in "repeat" mode).

export type Stop = {
  pos: number; // position in the gradient, 0..1
  color: [number, number, number]; // RGB 0..255
};

export type Palette = {
  name: string;
  stops: Stop[];
};

// Palette set. "Ice fractal" first (default); the others stay soft to avoid
// a garish look.
export const PALETTES: Palette[] = [
  {
    // The classic fractal gradient: deep blue → white → gold → black.
    name: "Ice fractal",
    stops: [
      { pos: 0.0, color: [0, 7, 100] },
      { pos: 0.16, color: [32, 107, 203] },
      { pos: 0.42, color: [237, 255, 255] },
      { pos: 0.6425, color: [255, 170, 0] },
      { pos: 0.8575, color: [0, 2, 0] },
      { pos: 1.0, color: [0, 7, 100] },
    ],
  },
  {
    name: "Glacier blue",
    stops: [
      { pos: 0.0, color: [8, 12, 40] },
      { pos: 0.5, color: [70, 150, 225] },
      { pos: 0.82, color: [220, 240, 255] },
      { pos: 1.0, color: [8, 12, 40] },
    ],
  },
  {
    name: "Embers",
    stops: [
      { pos: 0.0, color: [8, 2, 2] },
      { pos: 0.45, color: [130, 28, 12] },
      { pos: 0.72, color: [240, 140, 25] },
      { pos: 0.9, color: [255, 240, 190] },
      { pos: 1.0, color: [8, 2, 2] },
    ],
  },
  {
    name: "Forest",
    stops: [
      { pos: 0.0, color: [4, 18, 10] },
      { pos: 0.5, color: [40, 120, 60] },
      { pos: 0.82, color: [200, 230, 150] },
      { pos: 1.0, color: [4, 18, 10] },
    ],
  },
  {
    name: "Amethyst",
    stops: [
      { pos: 0.0, color: [14, 6, 28] },
      { pos: 0.5, color: [120, 60, 180] },
      { pos: 0.85, color: [232, 214, 250] },
      { pos: 1.0, color: [14, 6, 28] },
    ],
  },
  {
    name: "Greyscale",
    stops: [
      { pos: 0.0, color: [0, 0, 0] },
      { pos: 0.5, color: [150, 150, 150] },
      { pos: 0.85, color: [255, 255, 255] },
      { pos: 1.0, color: [0, 0, 0] },
    ],
  },
];

// Default palette on load: "Ice fractal".
export const DEFAULT_PALETTE = 0;

// Interpolates a colour in a palette at position t ∈ [0, 1].
function sampleStops(stops: Stop[], t: number): [number, number, number] {
  for (let k = 0; k < stops.length - 1; k++) {
    const s0 = stops[k];
    const s1 = stops[k + 1];
    if (t >= s0.pos && t <= s1.pos) {
      const span = s1.pos - s0.pos || 1;
      const f = (t - s0.pos) / span;
      return [
        s0.color[0] + (s1.color[0] - s0.color[0]) * f,
        s0.color[1] + (s1.color[1] - s0.color[1]) * f,
        s0.color[2] + (s1.color[2] - s0.color[2]) * f,
      ];
    }
  }
  const last = stops[stops.length - 1].color;
  return [last[0], last[1], last[2]];
}

// Builds the RGBA LUT (256×1) uploaded to the GPU as the palette texture.
export function buildPaletteLut(palette: Palette, size = 256): Uint8Array {
  const lut = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    // i/size (not size-1): the palette wraps around onto itself.
    const [r, g, b] = sampleStops(palette.stops, i / size);
    lut[i * 4] = Math.round(r);
    lut[i * 4 + 1] = Math.round(g);
    lut[i * 4 + 2] = Math.round(b);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

// CSS gradient reproducing the palette (for the UI preview swatch).
export function paletteGradientCss(palette: Palette): string {
  const parts = palette.stops.map(
    (s) => `rgb(${s.color[0]}, ${s.color[1]}, ${s.color[2]}) ${Math.round(s.pos * 100)}%`,
  );
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}
