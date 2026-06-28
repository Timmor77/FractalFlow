/**
 * Step 7 overlay: FPS, frame time, resolution, and iteration count.
 * Avoid introducing a UI framework for this small read-only surface.
 */

// Données affichées dans l'overlay de stats.
export type StatsData = {
  // Nombre total de rendus effectués.
  renderCount: number;

  // Temps CPU approximatif du dernier rendu.
  // Attention : WebGL est asynchrone, donc ce n'est pas le vrai temps GPU.
  lastRenderMs: number;

  // Centre X de la caméra dans le plan complexe.
  centerX: number;

  // Centre Y de la caméra dans le plan complexe.
  centerY: number;

  // Taille verticale visible dans le plan complexe.
  scale: number;

  // Nombre maximum d'itérations Julia.
  maxIter: number;
};

// Petit overlay HTML affiché par-dessus le canvas.
export class StatsOverlay {
  // Élément HTML principal de l'overlay.
  private readonly element: HTMLDivElement;

  constructor() {
    // On crée une div.
    this.element = document.createElement("div");

    // On lui donne un id pour pouvoir la styliser en CSS.
    this.element.id = "stats-overlay";

    // On l'ajoute à la page.
    document.body.appendChild(this.element);
  }

  // Met à jour le contenu affiché.
  public update(data: StatsData): void {
    // innerHTML permet d'afficher plusieurs lignes facilement.
    this.element.innerHTML = `
      <div>renders: ${data.renderCount}</div>
      <div>last render: ${data.lastRenderMs.toFixed(3)} ms</div>
      <div>center: ${data.centerX.toExponential(4)}, ${data.centerY.toExponential(4)}</div>
      <div>scale: ${data.scale.toExponential(4)}</div>
      <div>maxIter: ${data.maxIter}</div>
    `;
  }
}