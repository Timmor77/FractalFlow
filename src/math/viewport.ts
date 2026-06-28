/**
 * Defines screen-to-complex coordinate transforms, center, aspect ratio, and
 * scale. Keep this module independent from WebGL so it can be unit-tested.
 */

// Ce type représente un point 2D.
// On l'utilise pour les coordonnées complexes : x = partie réelle, y = partie imaginaire.
export type Point2D = {
    // Coordonnée horizontale.
    x: number;

    // Coordonnée verticale.
    y: number;
};

// Cette classe représente la "caméra" dans le plan complexe.
// Elle ne connaît rien à WebGL.
// Elle gère seulement le centre, le zoom, et les conversions de coordonnées.
export class Viewport {
    // Centre de la vue dans le plan complexe, partie réelle.
    public centerX = 0.0;

    // Centre de la vue dans le plan complexe, partie imaginaire.
    public centerY = 0.0;

    // Taille verticale visible dans le plan complexe.
    // Plus scale est petit, plus on zoome.
    public scale = 3.0;

    // Scale minimum provisoire.
    // En dessous, WebGL float32 perdra vite en précision.
    private readonly minScale = 1e-8;

    // Scale maximum provisoire.
    // Évite de dézoomer absurdement loin.
    private readonly maxScale = 100.0;

    // Convertit une position souris en coordonnées du plan complexe.
    public screenToComplex(
        // Position X de la souris en pixels navigateur.
        mouseX: number,

        // Position Y de la souris en pixels navigateur.
        mouseY: number,

        // Rectangle du canvas dans la page.
        rect: DOMRect,
    ): Point2D {
        // Position X locale dans le canvas.
        const localX = mouseX - rect.left;

        // Position Y locale dans le canvas.
        const localY = mouseY - rect.top;

        // Coordonnée X normalisée entre 0 et 1.
        const uvX = localX / rect.width;

        // Coordonnée Y normalisée entre 0 et 1.
        const uvY = localY / rect.height;

        // Coordonnée X centrée autour de 0.
        // Gauche = -0.5, droite = 0.5.
        const centeredX = uvX - 0.5;

        // Coordonnée Y centrée autour de 0.
        // On inverse Y parce que dans le navigateur Y augmente vers le bas,
        // alors que dans le plan complexe on veut Y qui augmente vers le haut.
        const centeredY = 0.5 - uvY;

        // Ratio largeur / hauteur du canvas.
        const aspect = rect.width / rect.height;

        // Conversion vers le plan complexe.
        return {
            x: this.centerX + centeredX * aspect * this.scale,
            y: this.centerY + centeredY * this.scale,
        };
    }

    // Zoome autour d'un point précis de l'écran.
    public zoomAt(
        // Position X de la souris.
        mouseX: number,

        // Position Y de la souris.
        mouseY: number,

        // Rectangle du canvas.
        rect: DOMRect,

        // deltaY vient de l'événement wheel.
        // deltaY < 0 : zoom in.
        // deltaY > 0 : zoom out.
        deltaY: number,
    ): void {
        // Point complexe sous la souris avant le zoom.
        const beforeZoom = this.screenToComplex(mouseX, mouseY, rect);

        // Facteur de zoom.
        const zoomFactor = 0.9;

        // Si deltaY < 0, l'utilisateur zoome.
        if (deltaY < 0) {
            this.scale *= zoomFactor;
        } else {
            // Sinon, il dézoome.
            this.scale /= zoomFactor;
        }

        // On limite le scale pour éviter des valeurs absurdes.
        this.scale = Math.max(this.scale, this.minScale);
        this.scale = Math.min(this.scale, this.maxScale);

        // Point complexe sous la souris après le changement de scale.
        const afterZoom = this.screenToComplex(mouseX, mouseY, rect);

        // Correction du centre.
        // But : le point visé avant zoom doit rester sous la souris après zoom.
        this.centerX += beforeZoom.x - afterZoom.x;
        this.centerY += beforeZoom.y - afterZoom.y;
    }

    // Déplace la vue à partir d'un déplacement souris en pixels.
    public panByPixels(
        // Déplacement horizontal souris en pixels.
        deltaX: number,

        // Déplacement vertical souris en pixels.
        deltaY: number,

        // Largeur du canvas en pixels CSS.
        width: number,

        // Hauteur du canvas en pixels CSS.
        height: number,
    ): void {
        // Ratio largeur / hauteur.
        const aspect = width / height;

        // Conversion du déplacement horizontal en unités du plan complexe.
        const complexDeltaX = (deltaX / width) * this.scale * aspect;

        // Conversion du déplacement vertical en unités du plan complexe.
        const complexDeltaY = (deltaY / height) * this.scale;

        // Quand on tire l'image vers la droite, la caméra doit aller à gauche.
        this.centerX -= complexDeltaX;

        // Y écran augmente vers le bas, Y complexe augmente vers le haut.
        this.centerY += complexDeltaY;
    }
}