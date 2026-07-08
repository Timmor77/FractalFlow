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

  // Limite haute : à peine au-dessus de la vue par défaut (3.0). Au-delà la
  // fractale rétrécit jusqu'à disparaître, donc on empêche de trop dézoomer.
  private readonly maxScale = 4.0;

  // Intensité du zoom molette (formule exponentielle, souple souris/trackpad).
  private readonly wheelZoomStrength = 0.002;

  // --- Zoom fluide (inertiel) ---
  // La molette ne change pas `scale` directement : elle déplace une CIBLE, et
  // `scale` la rejoint en douceur frame par frame (voir advanceZoom). L'ancre est
  // le point du plan sous le curseur, gardé fixe pendant tout le mouvement.
  private targetScale = this.initialScale;
  private anchorFx = 0; // position normalisée du curseur (corrigée de l'aspect)
  private anchorFy = 0;
  private readonly zoomEase = 0.2; // fraction de l'écart rattrapée par frame

  // Remet la caméra à l'état initial.
  public reset(): void {
    this.centerX = ddFromNumber(this.initialCenterX);
    this.centerY = ddFromNumber(this.initialCenterY);
    this.scale = this.initialScale;
    this.targetScale = this.initialScale;
  }

  // Restaure une vue complète (reprise d'un état depuis l'URL).
  public setView(centerX: Dd, centerY: Dd, scale: number): void {
    this.centerX = centerX;
    this.centerY = centerY;
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, scale));
    this.targetScale = this.scale;
  }

  // Niveau de zoom indicatif : 0 au départ, +1 par facteur 2 de zoom.
  public getZoomLevel(): number {
    return Math.max(0, Math.log2(this.initialScale / this.scale));
  }

  // Vrai quand on a atteint la profondeur maximale (précision du centre DD).
  // Au-delà, zoomer ne change plus rien : inutile de recalculer l'image.
  public isAtMaxDepth(): boolean {
    return this.scale <= this.minScale;
  }

  // Met à jour la CIBLE de zoom autour du curseur à partir d'un cran de molette.
  // deltaY < 0 => zoom in (facteur < 1), deltaY > 0 => zoom out.
  public nudgeZoom(mouseX: number, mouseY: number, rect: DOMRect, deltaY: number): "zoom" | "blocked" {
    const clampedDeltaY = Math.max(-120, Math.min(120, deltaY));
    const factor = Math.exp(clampedDeltaY * this.wheelZoomStrength);
    return this.nudgeZoomByFactor(mouseX, mouseY, rect, factor);
  }

  // Met à jour la CIBLE de zoom autour d'un point écran (le zoom est ensuite animé
  // par advanceZoom). L'ancre = point du plan sous le curseur (ou le milieu du
  // pinch), gardé fixe. Renvoie "blocked" si on est déjà à une borne et qu'on
  // pousse encore dans le même sens (rien à animer, l'image serait identique).
  public nudgeZoomByFactor(mouseX: number, mouseY: number, rect: DOMRect, factor: number): "zoom" | "blocked" {
    // Position du point d'ancrage, centrée sur 0 et corrigée du ratio d'aspect.
    const localX = mouseX - rect.left;
    const localY = mouseY - rect.top;
    const aspect = rect.width / rect.height;
    this.anchorFx = (localX / rect.width - 0.5) * aspect;
    this.anchorFy = 0.5 - localY / rect.height; // y écran vers le bas, y complexe vers le haut

    const before = this.targetScale;
    this.targetScale = Math.max(this.minScale, Math.min(this.maxScale, before * factor));

    if (this.targetScale !== before) {
      return "zoom";
    }
    // Cible inchangée : bloqué seulement si l'échelle est déjà sur la borne.
    return this.scale <= this.minScale || this.scale >= this.maxScale ? "blocked" : "zoom";
  }

  // Avance l'animation de zoom d'une frame. Renvoie true tant que ça bouge.
  // On interpole en espace log (perception uniforme du zoom).
  public advanceZoom(): boolean {
    const logCur = Math.log(this.scale);
    const logTarget = Math.log(this.targetScale);
    const delta = logTarget - logCur;

    // Assez proche : on colle à la cible et on s'arrête.
    if (Math.abs(delta) < 1e-4) {
      if (this.scale !== this.targetScale) {
        this.applyScaleAnchored(this.targetScale);
      }
      return false;
    }
    this.applyScaleAnchored(Math.exp(logCur + delta * this.zoomEase));
    return true;
  }

  // Applique une nouvelle échelle en gardant l'ancre fixe.
  // Correction du centre = offset_avant - offset_après = ancre * (scaleAvant - scaleAprès).
  // Le centre s'annule dans la différence : on n'ajoute qu'un petit delta float64
  // au centre double-double.
  private applyScaleAnchored(newScale: number): void {
    const scaleBefore = this.scale;
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, newScale));
    const scaleDelta = scaleBefore - this.scale;
    this.centerX = ddAddNumber(this.centerX, this.anchorFx * scaleDelta);
    this.centerY = ddAddNumber(this.centerY, this.anchorFy * scaleDelta);
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
