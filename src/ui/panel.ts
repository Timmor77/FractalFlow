// Panneau de contrôle (bas de l'écran) : palettes, sélecteur de c (mini
// Mandelbrot), export PNG, reset. Purement DOM ; il ne fait que remonter des
// callbacks à main.ts, qui détient l'état et déclenche les rendus.

import { PALETTES, paletteGradientCss } from "./palettes";
import { createMandelbrotPicker } from "./mandelbrotPicker";

export type ControlPanelOptions = {
  initialPalette: number;
  initialC: { x: number; y: number };
  onSelectPalette: (index: number) => void;
  onPickC: (cx: number, cy: number) => void;
  onSave: () => void;
  onReset: () => void;
};

export type ControlPanel = {
  element: HTMLElement;
  // Bascule l'état visuel du bouton d'export pendant la génération de l'image.
  setSaving(saving: boolean): void;
};

export function createControlPanel(opts: ControlPanelOptions): ControlPanel {
  const element = document.createElement("div");
  element.className = "control-panel";

  // --- Section palettes ---
  const palSection = document.createElement("div");
  palSection.className = "panel-section";
  palSection.appendChild(makeLabel("Palette"));

  const swatches = document.createElement("div");
  swatches.className = "swatches";
  const swatchButtons: HTMLButtonElement[] = [];
  PALETTES.forEach((palette, index) => {
    const button = document.createElement("button");
    button.className = "swatch";
    button.title = palette.name;
    button.style.backgroundImage = paletteGradientCss(palette);
    if (index === opts.initialPalette) {
      button.classList.add("active");
    }
    button.addEventListener("click", () => {
      swatchButtons.forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      opts.onSelectPalette(index);
    });
    swatchButtons.push(button);
    swatches.appendChild(button);
  });
  palSection.appendChild(swatches);
  element.appendChild(palSection);

  // --- Section sélecteur de c (mini Mandelbrot) ---
  const cSection = document.createElement("div");
  cSection.className = "panel-section";
  cSection.appendChild(makeLabel("Paramètre c — glisse sur la carte"));

  const readout = document.createElement("div");
  readout.className = "c-readout";
  const updateReadout = (cx: number, cy: number): void => {
    const sign = cy >= 0 ? "+" : "−";
    readout.textContent = `c = ${cx.toFixed(4)} ${sign} ${Math.abs(cy).toFixed(4)} i`;
  };

  const picker = createMandelbrotPicker((cx, cy) => {
    updateReadout(cx, cy);
    opts.onPickC(cx, cy);
  });
  cSection.appendChild(picker.element);
  cSection.appendChild(readout);
  element.appendChild(cSection);

  // Position initiale du marqueur + lecture.
  picker.setC(opts.initialC.x, opts.initialC.y);
  updateReadout(opts.initialC.x, opts.initialC.y);

  // --- Boutons ---
  const actions = document.createElement("div");
  actions.className = "panel-actions";

  const saveButton = document.createElement("button");
  saveButton.className = "action-button primary";
  saveButton.textContent = "Enregistrer l'image";
  saveButton.addEventListener("click", () => opts.onSave());
  actions.appendChild(saveButton);

  const resetButton = document.createElement("button");
  resetButton.className = "action-button";
  resetButton.textContent = "Réinitialiser la vue";
  resetButton.addEventListener("click", () => opts.onReset());
  actions.appendChild(resetButton);

  element.appendChild(actions);

  return {
    element,
    setSaving(saving: boolean): void {
      saveButton.disabled = saving;
      saveButton.textContent = saving ? "Génération…" : "Enregistrer l'image";
    },
  };
}

function makeLabel(text: string): HTMLElement {
  const label = document.createElement("div");
  label.className = "panel-label";
  label.textContent = text;
  return label;
}
