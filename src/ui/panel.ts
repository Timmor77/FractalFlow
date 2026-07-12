// Control panel (bottom of the screen): palettes, c picker (mini Mandelbrot),
// PNG export, reset. Pure DOM; it only surfaces callbacks to main.ts, which
// owns the state and triggers renders.

import { PALETTES, paletteGradientCss } from "./palettes";
import { createMandelbrotPicker } from "./mandelbrotPicker";

export type ControlPanelOptions = {
  initialPalette: number;
  initialC: { x: number; y: number };
  onSelectPalette: (index: number) => void;
  onPickC: (cx: number, cy: number) => void;
  onSave: () => void;
  onReset: () => void;
  onCopyLink: () => void;
};

export type ControlPanel = {
  element: HTMLElement;
  // Small floating button that shows/hides the panel. The CSS only displays
  // it on small (mobile) screens, where the full panel would cover the view.
  toggleElement: HTMLElement;
  // Toggles the export button's visual state while the image is generated.
  setSaving(saving: boolean): void;
  // Brief visual feedback after the link is copied.
  flashCopied(): void;
  // Syncs the display (fields + marker) with a c coming from outside
  // (e.g. restoring a shared link). Does not trigger onPickC.
  setC(cx: number, cy: number): void;
  // Syncs the active palette swatch. Does not trigger onSelectPalette.
  setPalette(index: number): void;
};

export function createControlPanel(opts: ControlPanelOptions): ControlPanel {
  const element = document.createElement("div");
  element.className = "control-panel";

  // --- Mobile show/hide toggle ---
  // On phones the panel starts hidden behind this button: the fractal is the
  // point, not the controls. Desktop never sees the button (CSS) and the
  // panel stays visible there whatever the class says.
  const toggle = document.createElement("button");
  toggle.className = "panel-toggle";
  toggle.setAttribute("aria-label", "Show or hide the controls");
  toggle.textContent = "🎛";
  if (window.matchMedia("(max-width: 640px)").matches) {
    element.classList.add("panel-hidden");
  }
  toggle.addEventListener("click", () => {
    element.classList.toggle("panel-hidden");
  });

  // --- Palettes section ---
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

  // --- c picker section (mini Mandelbrot + manual input) ---
  const cSection = document.createElement("div");
  cSection.className = "panel-section";
  cSection.appendChild(makeLabel("Parameter c — drag on the map or type"));

  // c input fields (real + imaginary parts).
  const reInput = makeNumberInput();
  const imInput = makeNumberInput();

  // The map updates the fields while dragging.
  const picker = createMandelbrotPicker((cx, cy) => {
    reInput.value = cx.toFixed(4);
    imInput.value = cy.toFixed(4);
    opts.onPickC(cx, cy);
  });
  cSection.appendChild(picker.element);

  // Manual input updates the map (marker) and the fractal.
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

  // Initial state: fields + marker.
  reInput.value = opts.initialC.x.toFixed(4);
  imInput.value = opts.initialC.y.toFixed(4);
  picker.setC(opts.initialC.x, opts.initialC.y);

  // --- Buttons ---
  const actions = document.createElement("div");
  actions.className = "panel-actions";

  const saveLabel = "Save image <kbd>S</kbd>";
  const saveButton = document.createElement("button");
  saveButton.className = "action-button primary";
  saveButton.innerHTML = saveLabel;
  saveButton.addEventListener("click", () => opts.onSave());
  actions.appendChild(saveButton);

  const copyLabel = "Copy link";
  const copyButton = document.createElement("button");
  copyButton.className = "action-button";
  copyButton.textContent = copyLabel;
  copyButton.addEventListener("click", () => opts.onCopyLink());
  actions.appendChild(copyButton);

  const resetButton = document.createElement("button");
  resetButton.className = "action-button";
  resetButton.innerHTML = "Reset view <kbd>R</kbd>";
  resetButton.addEventListener("click", () => opts.onReset());
  actions.appendChild(resetButton);

  element.appendChild(actions);

  let copyTimer: number | null = null;

  const setC = (cx: number, cy: number): void => {
    reInput.value = cx.toFixed(4);
    imInput.value = cy.toFixed(4);
    picker.setC(cx, cy);
  };

  return {
    element,
    toggleElement: toggle,
    setC,
    setPalette(index: number): void {
      swatchButtons.forEach((b, i) => b.classList.toggle("active", i === index));
    },
    setSaving(saving: boolean): void {
      saveButton.disabled = saving;
      if (saving) {
        saveButton.textContent = "Rendering…";
      } else {
        saveButton.innerHTML = saveLabel;
      }
    },
    flashCopied(): void {
      copyButton.textContent = "Link copied!";
      if (copyTimer !== null) {
        clearTimeout(copyTimer);
      }
      copyTimer = window.setTimeout(() => {
        copyButton.textContent = copyLabel;
        copyTimer = null;
      }, 1400);
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
