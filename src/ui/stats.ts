// Stats overlay shown in the top-left corner.
// Purely informative: active backend, render time, position, zoom.

export type StatsData = {
  // Active render backend ("WebGPU" or "WebGL2").
  backend: string;

  // Total number of renders performed.
  renderCount: number;

  // CPU time of the last render, in milliseconds.
  lastRenderMs: number;

  // Frames per second (rolling average), 0 while unknown.
  fps: number;

  // Reference orbit length (perturbation). 0 for WebGL2.
  refLength: number;

  // Camera centre (float64 approximation, for display).
  centerX: number;
  centerY: number;

  // Vertical size visible in the complex plane.
  scale: number;

  // Indicative zoom level (1 level = ×2).
  zoomLevel: number;

  // Iterations sent to the renderer.
  maxIter: number;

  // True when the maximum depth is reached (precision limit).
  atMaxDepth: boolean;
};

export class StatsOverlay {
  private readonly element: HTMLDivElement;

  constructor() {
    this.element = document.createElement("div");
    this.element.id = "stats-overlay";
    document.body.appendChild(this.element);
  }

  public update(data: StatsData): void {
    // The "ref orbit" line only makes sense for perturbation (WebGPU).
    const refLine =
      data.refLength > 0 ? `<div>ref orbit: ${data.refLength}</div>` : "";

    const fpsLine = data.fps > 0 ? `<div>fps: ${data.fps.toFixed(0)}</div>` : "";
    const limitLine = data.atMaxDepth
      ? `<div class="stats-limit">⚠ maximum depth reached</div>`
      : "";

    this.element.innerHTML = `
      <div class="stats-title">FractalFlow</div>
      <div>backend: ${data.backend}</div>
      ${fpsLine}
      <div>last render: ${data.lastRenderMs.toFixed(2)} ms</div>
      ${refLine}
      <div>centerX: ${data.centerX.toExponential(6)}</div>
      <div>centerY: ${data.centerY.toExponential(6)}</div>
      <div>scale: ${data.scale.toExponential(6)}</div>
      <div>zoom: ×${Math.pow(2, data.zoomLevel).toExponential(2)}</div>
      <div>maxIter: ${data.maxIter}</div>
      ${limitLine}
    `;
  }
}
