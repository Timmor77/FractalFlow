// Viewport = caméra mathématique dans le plan complexe.
// Cette classe ne connaît rien aux backends de rendu (WebGPU, WebGL2).
//
// Nouveauté deep zoom : le centre est stocké en double-double (~31 chiffres).
// C'est ce qui permet de descendre bien plus bas que float64 (~16 chiffres) et
// donc de placer correctement l'orbite de référence de la perturbation.
// La taille de vue (scale) reste un float64 : seul son EXPOSANT compte, pas ses
// chiffres, et un float64 atteint sans souci 1e-100.

import type { Dd } from "./doubleDouble";
import { ddFromNumber, ddToNumber, ddAddNumber } from "./doubleDouble";

export class Viewport {
  // Valeurs initiales utilisées par reset().
  private readonly initialCenterX = 0.0;
  private readonly initialCenterY = 0.0;
  private readonly initialScale = 3.0;

  // Centre de la vue en double-double.
  public centerX: Dd = ddFromNumber(this.initialCenterX);
  public centerY: Dd = ddFromNumber(this.initialCenterY);

  // Taille verticale visible dans le plan complexe. Plus c'est petit, plus on zoome.
  public scale = this.initialScale;

  // Limite basse du zoom. Fixée par la précision du centre double-double :
  // ~31 chiffres de mantisse pour des valeurs d'ordre 1 => on garde une marge
  // confortable jusqu'à ~1e-28 avant de voir la précision se dégrader.
  private readonly minScale = 1e-28;

  // Limite haute, pour éviter de dézoomer absurdement loin.
  private readonly maxScale = 100.0;

  // Intensité du zoom molette (formule exponentielle, souple souris/trackpad).
  private readonly wheelZoomStrength = 0.002;

  // Remet la caméra à l'état initial.
  public reset(): void {
    this.centerX = ddFromNumber(this.initialCenterX);
    this.centerY = ddFromNumber(this.initialCenterY);
    this.scale = this.initialScale;
  }

  // Niveau de zoom indicatif : 0 au départ, +1 par facteur 2 de zoom.
  public getZoomLevel(): number {
    return Math.max(0, Math.log2(this.initialScale / this.scale));
  }

  // Zoome autour de la souris en gardant le point complexe sous le curseur fixe.
  //
  // Le point sous le curseur = centre + offset, où offset = f(curseur) * scale.
  // Pour le garder fixe, il suffit de corriger le centre par (offset_avant - offset_après).
  // Le centre s'annule dans la différence : on n'a besoin QUE de ce petit delta
  // float64, qu'on ajoute proprement au centre double-double.
  public zoomAt(mouseX: number, mouseY: number, rect: DOMRect, deltaY: number): void {
    // Position du curseur, centrée sur 0 et corrigée du ratio d'aspect.
    const localX = mouseX - rect.left;
    const localY = mouseY - rect.top;
    const aspect = rect.width / rect.height;
    const fx = (localX / rect.width - 0.5) * aspect;
    const fy = 0.5 - localY / rect.height; // y écran vers le bas, y complexe vers le haut

    const scaleBefore = this.scale;

    // deltaY < 0 => zoom in (facteur < 1), deltaY > 0 => zoom out.
    // On borne les deltaY énormes de certains trackpads.
    const clampedDeltaY = Math.max(-120, Math.min(120, deltaY));
    const factor = Math.exp(clampedDeltaY * this.wheelZoomStrength);

    this.scale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));

    // Correction du centre = offset_avant - offset_après = f * (scaleBefore - scaleAfter).
    const scaleDelta = scaleBefore - this.scale;
    this.centerX = ddAddNumber(this.centerX, fx * scaleDelta);
    this.centerY = ddAddNumber(this.centerY, fy * scaleDelta);
  }

  // Déplacement par drag souris.
  public panByPixels(deltaX: number, deltaY: number, width: number, height: number): void {
    const aspect = width / height;

    // Conversion pixels -> distance complexe (petit delta float64).
    const complexDeltaX = (deltaX / width) * this.scale * aspect;
    const complexDeltaY = (deltaY / height) * this.scale;

    // Drag vers la droite = caméra vers la gauche ; y écran inversé.
    this.centerX = ddAddNumber(this.centerX, -complexDeltaX);
    this.centerY = ddAddNumber(this.centerY, complexDeltaY);
  }

  // Centre approché en float64, pour l'affichage et le fallback WebGL2.
  public getCenterXNumber(): number {
    return ddToNumber(this.centerX);
  }

  public getCenterYNumber(): number {
    return ddToNumber(this.centerY);
  }
}
