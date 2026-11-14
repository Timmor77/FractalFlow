// Control panel (bottom of the screen): palettes, c picker (mini Mandelbrot),
// PNG export, reset. Pure DOM; it only surfaces callbacks to main.ts, which
// owns the state and triggers renders.

import { PALETTES, paletteGradientCss } from "./palettes";
import { createMandelbrotPicker } from "./mandelbrotPicker";
import { EXPORT_SIZES, DEFAULT_EXPORT_SIZE } from "../core/config";

export type ControlPanelOptions = {
  initialPalette: number;
  initialC: { x: number; y: number };
  onSelectPalette: (index: number) => void;
  onPickC: (cx: number, cy: number) => void;
  // Save button: starts an export, or cancels the one in progress.
  onSave: () => void;
  onCancelSave: () => void;
  onReset: () => void;
  onCopyLink: () => void;
};

export type ControlPanel = {
  element: HTMLElement;
  // Small floating button that shows/hides the panel. The CSS only displays
  // it on small (mobile) screens, where the full panel would cover the view.
  toggleElement: HTMLElement;
  // Longest side (px) currently selected for the export.
  getExportSide(): number;
  // Switches the save button between "Save image" and "Cancel" while the
  // image is generated.
  setSaving(saving: boolean): void;
  // Progress of the export in progress, 0..1, shown on the button.
  setSaveProgress(fraction: number): void;
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
    // The swatch is a gradient with no text: name it for screen readers.
    button.setAttribute("aria-label", `${palette.name} palette`);
    button.style.backgroundImage = paletteGradientCss(palette);
    button.addEventListener("click", () => {
      markActiveSwatch(index);
      opts.onSelectPalette(index);
    });
    swatchButtons.push(button);
    swatches.appendChild(button);
  });
  palSection.appendChild(swatches);
  element.appendChild(palSection);

  // Highlights the selected swatch, visually and for assistive technology.
  function markActiveSwatch(active: number): void {
    swatchButtons.forEach((b, i) => {
      b.classList.toggle("active", i === active);
      b.setAttribute("aria-pressed", String(i === active));
    });
  }
  markActiveSwatch(opts.initialPalette);

  // --- c picker section (mini Mandelbrot + manual input) ---
  const cSection = document.createElement("div");
  cSection.className = "panel-section";
  cSection.appendChild(makeLabel("Parameter c — drag on the map or type"));

  // c input fields (real + imaginary parts).
  const reInput = makeNumberInput("Real part of c");
  const imInput = makeNumberInput("Imaginary part of c");

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

  // Save button + export size, side by side.
  const saveRow = document.createElement("div");
  saveRow.className = "save-row";

  const saveLabel = "Save image <kbd>S</kbd>";
  let saving = false;
  const saveButton = document.createElement("button");
  saveButton.className = "action-button primary";
  saveButton.innerHTML = saveLabel;
  saveButton.addEventListener("click", () => {
    if (saving) {
      opts.onCancelSave();
    } else {
      opts.onSave();
    }
  });

  const sizeSelect = document.createElement("select");
  sizeSelect.className = "size-select";
  sizeSelect.setAttribute("aria-label", "Export size (longest side)");
  EXPORT_SIZES.forEach((size, index) => {
    const option = document.createElement("option");
    option.value = String(size.side);
    option.textContent = size.label;
    option.selected = index === DEFAULT_EXPORT_SIZE;
    sizeSelect.appendChild(option);
  });

  saveRow.append(saveButton, sizeSelect);
  actions.appendChild(saveRow);

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
    setPalette: markActiveSwatch,
    getExportSide: () => Number(sizeSelect.value),
    setSaving(next: boolean): void {
      saving = next;
      sizeSelect.disabled = next;
      if (next) {
        saveButton.textContent = "Rendering… (cancel)";
      } else {
        saveButton.innerHTML = saveLabel;
      }
    },
    setSaveProgress(fraction: number): void {
      if (saving) {
        saveButton.textContent = `Rendering ${Math.round(fraction * 100)}% (cancel)`;
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

function makeNumberInput(label: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.setAttribute("aria-label", label);
  input.step = "0.001";
  input.className = "c-input";
  return input;
}

function makeSpan(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}
