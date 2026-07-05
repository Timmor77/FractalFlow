// Overlay de statistiques affiché en haut à gauche.
// Purement informatif : backend actif, temps de rendu, position, zoom.

export type StatsData = {
  // Backend de rendu actif ("WebGPU" ou "WebGL2").
  backend: string;

  // Nombre total de rendus effectués.
  renderCount: number;

  // Temps CPU du dernier rendu, en millisecondes.
  lastRenderMs: number;

  // Images par seconde (moyenne glissante), 0 tant qu'inconnu.
  fps: number;

  // Longueur de l'orbite de référence (perturbation). 0 pour WebGL2.
  refLength: number;

  // Centre de la caméra (approché en float64 pour l'affichage).
  centerX: number;
  centerY: number;

  // Taille verticale visible dans le plan complexe.
  scale: number;

  // Niveau de zoom indicatif (1 niveau = ×2).
  zoomLevel: number;

  // Itérations envoyées au rendu.
  maxIter: number;
};

export class StatsOverlay {
  private readonly element: HTMLDivElement;

  constructor() {
    this.element = document.createElement("div");
    this.element.id = "stats-overlay";
    document.body.appendChild(this.element);
  }

  public update(data: StatsData): void {
    // La ligne "ref orbit" n'a de sens que pour la perturbation (WebGPU).
    const refLine =
      data.refLength > 0 ? `<div>ref orbit: ${data.refLength}</div>` : "";

    const fpsLine = data.fps > 0 ? `<div>fps: ${data.fps.toFixed(0)}</div>` : "";

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
    `;
  }
}
