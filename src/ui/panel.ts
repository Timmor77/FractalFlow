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

  // --- Section sélecteur de c (mini Mandelbrot + saisie manuelle) ---
  const cSection = document.createElement("div");
  cSection.className = "panel-section";
  cSection.appendChild(makeLabel("Paramètre c — glisse sur la carte ou saisis"));

  // Champs de saisie de c (partie réelle + imaginaire).
  const reInput = makeNumberInput();
  const imInput = makeNumberInput();

  // La carte met à jour les champs quand on la glisse.
  const picker = createMandelbrotPicker((cx, cy) => {
    reInput.value = cx.toFixed(4);
    imInput.value = cy.toFixed(4);
    opts.onPickC(cx, cy);
  });
  cSection.appendChild(picker.element);

  // La saisie manuelle met à jour la carte (marqueur) et la fractale.
  const applyFromInputs = (): void => {
    const cx = parseFloat(reInput.value);
    const cy = parseFloat(imInput.value);
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      picker.setC(cx, cy);
      opts.onPickC(cx, cy);
    }
  };
  reInput.addEventListener("input", applyFromInputs);
  imInput.addEventListener("input", applyFromInputs);

  const cInputs = document.createElement("div");
  cInputs.className = "c-inputs";
  cInputs.append(makeSpan("c ="), reInput, makeSpan("+"), imInput, makeSpan("i"));
  cSection.appendChild(cInputs);
  element.appendChild(cSection);

  // État initial : champs + marqueur.
  reInput.value = opts.initialC.x.toFixed(4);
  imInput.value = opts.initialC.y.toFixed(4);
  picker.setC(opts.initialC.x, opts.initialC.y);

  // --- Boutons ---
  const actions = document.createElement("div");
  actions.className = "panel-actions";

  const saveLabel = "Enregistrer l'image <kbd>S</kbd>";
  const saveButton = document.createElement("button");
  saveButton.className = "action-button primary";
  saveButton.innerHTML = saveLabel;
  saveButton.addEventListener("click", () => opts.onSave());
  actions.appendChild(saveButton);

  const resetButton = document.createElement("button");
  resetButton.className = "action-button";
  resetButton.innerHTML = "Réinitialiser la vue <kbd>R</kbd>";
  resetButton.addEventListener("click", () => opts.onReset());
  actions.appendChild(resetButton);

  element.appendChild(actions);

  return {
    element,
    setSaving(saving: boolean): void {
      saveButton.disabled = saving;
      if (saving) {
        saveButton.textContent = "Génération…";
      } else {
        saveButton.innerHTML = saveLabel;
      }
    },
  };
}

function makeLabel(text: string): HTMLElement {
  const label = document.createElement("div");
  label.className = "panel-label";
  label.textContent = text;
  return label;
}

function makeNumberInput(): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.step = "0.001";
  input.className = "c-input";
  return input;
}

function makeSpan(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}
