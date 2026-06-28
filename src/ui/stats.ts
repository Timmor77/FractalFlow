// Données affichées dans l'overlay de stats.
export type StatsData = {
  // Nombre total de rendus effectués.
  renderCount: number;

  // Temps CPU approximatif du dernier rendu.
  lastRenderMs: number;

  // Centre X de la caméra.
  centerX: number;

  // Centre Y de la caméra.
  centerY: number;

  // Taille verticale visible.
  scale: number;

  // Niveau de zoom indicatif.
  zoomLevel: number;

  // Nombre d'itérations réellement envoyé au shader.
  maxIter: number;
};

// Overlay HTML simple.
export class StatsOverlay {
  // Élément HTML principal.
  private readonly element: HTMLDivElement;

  constructor() {
    // Crée une div.
    this.element = document.createElement("div");

    // Id utilisé par le CSS.
    this.element.id = "stats-overlay";

    // Ajoute l'overlay à la page.
    document.body.appendChild(this.element);
  }

  // Met à jour le contenu affiché.
  public update(data: StatsData): void {
    this.element.innerHTML = `
      <div>renders: ${data.renderCount}</div>
      <div>last render: ${data.lastRenderMs.toFixed(3)} ms</div>
      <div>centerX: ${data.centerX.toExponential(6)}</div>
      <div>centerY: ${data.centerY.toExponential(6)}</div>
      <div>scale: ${data.scale.toExponential(6)}</div>
      <div>zoom level: ${data.zoomLevel.toFixed(2)}</div>
      <div>maxIter: ${data.maxIter}</div>
      <div>reset: R</div>
    `;
  }
}