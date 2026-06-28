// Point 2D générique.
// Pour nous : x = partie réelle, y = partie imaginaire.
export type Point2D = {
  x: number;
  y: number;
};

// Représentation high/low d'un nombre JavaScript.
// high est la partie représentable en float32.
// low est le reste.
export type SplitNumber = {
  high: number;
  low: number;
};

// Sépare un number JavaScript float64 en deux morceaux.
// Math.fround convertit explicitement vers float32.
// value = high + low, avec high envoyé proprement au GPU et low comme correction.
export function splitNumber(value: number): SplitNumber {
  const high = Math.fround(value);
  const low = value - high;

  return { high, low };
}

// Viewport = caméra mathématique dans le plan complexe.
// Cette classe ne connaît rien à WebGL.
export class Viewport {
  // Valeurs initiales utilisées par reset().
  private readonly initialCenterX = 0.0;
  private readonly initialCenterY = 0.0;
  private readonly initialScale = 3.0;

  // Centre de la vue, partie réelle.
  public centerX = this.initialCenterX;

  // Centre de la vue, partie imaginaire.
  public centerY = this.initialCenterY;

  // Taille verticale visible dans le plan complexe.
  // Plus scale est petit, plus on zoome.
  public scale = this.initialScale;

  // Limite minimale provisoire.
  // Avec le double-single, on peut descendre plus bas que float32 simple,
  // mais ce n'est toujours pas du vrai deep zoom infini.
  private readonly minScale = 1e-14;

  // Limite maximale pour éviter de dézoomer absurdement loin.
  private readonly maxScale = 100.0;

  // Intensité du zoom.
  // On utilise une formule exponentielle pour mieux gérer souris et trackpads.
  private readonly wheelZoomStrength = 0.002;

  // Remet la caméra à l'état initial.
  public reset(): void {
    this.centerX = this.initialCenterX;
    this.centerY = this.initialCenterY;
    this.scale = this.initialScale;
  }

  // Niveau de zoom indicatif.
  // 0 au départ, augmente quand scale diminue.
  public getZoomLevel(): number {
    return Math.max(0, Math.log2(this.initialScale / this.scale));
  }

  // Retourne centerX séparé en high/low.
  public getCenterXSplit(): SplitNumber {
    return splitNumber(this.centerX);
  }

  // Retourne centerY séparé en high/low.
  public getCenterYSplit(): SplitNumber {
    return splitNumber(this.centerY);
  }

  // Retourne scale séparé en high/low.
  public getScaleSplit(): SplitNumber {
    return splitNumber(this.scale);
  }

  // Convertit une position souris en coordonnées du plan complexe.
  public screenToComplex(mouseX: number, mouseY: number, rect: DOMRect): Point2D {
    // Position locale de la souris dans le canvas.
    const localX = mouseX - rect.left;
    const localY = mouseY - rect.top;

    // Coordonnées normalisées entre 0 et 1.
    const uvX = localX / rect.width;
    const uvY = localY / rect.height;

    // Recentre x autour de 0.
    const centeredX = uvX - 0.5;

    // Inverse y : écran vers le bas, plan complexe vers le haut.
    const centeredY = 0.5 - uvY;

    // Ratio largeur / hauteur.
    const aspect = rect.width / rect.height;

    // Conversion écran -> plan complexe.
    return {
      x: this.centerX + centeredX * aspect * this.scale,
      y: this.centerY + centeredY * this.scale,
    };
  }

  // Zoome autour de la souris.
  public zoomAt(mouseX: number, mouseY: number, rect: DOMRect, deltaY: number): void {
    // Point complexe sous la souris avant zoom.
    const beforeZoom = this.screenToComplex(mouseX, mouseY, rect);

    // On limite les deltaY énormes envoyés parfois par certains touchpads.
    const clampedDeltaY = Math.max(-120, Math.min(120, deltaY));

    // Facteur exponentiel :
    // deltaY < 0 => facteur < 1 => zoom in
    // deltaY > 0 => facteur > 1 => zoom out
    const factor = Math.exp(clampedDeltaY * this.wheelZoomStrength);

    // Applique le zoom.
    this.scale *= factor;

    // Clamp de sécurité.
    this.scale = Math.max(this.minScale, this.scale);
    this.scale = Math.min(this.maxScale, this.scale);

    // Point complexe sous la souris après zoom.
    const afterZoom = this.screenToComplex(mouseX, mouseY, rect);

    // Corrige le centre pour garder le même point sous le curseur.
    this.centerX += beforeZoom.x - afterZoom.x;
    this.centerY += beforeZoom.y - afterZoom.y;
  }

  // Déplacement par drag souris.
  public panByPixels(deltaX: number, deltaY: number, width: number, height: number): void {
    // Ratio largeur / hauteur.
    const aspect = width / height;

    // Conversion pixel -> distance complexe horizontale.
    const complexDeltaX = (deltaX / width) * this.scale * aspect;

    // Conversion pixel -> distance complexe verticale.
    const complexDeltaY = (deltaY / height) * this.scale;

    // Drag vers la droite = caméra vers la gauche.
    this.centerX -= complexDeltaX;

    // Y écran vers le bas, Y complexe vers le haut.
    this.centerY += complexDeltaY;
  }
}