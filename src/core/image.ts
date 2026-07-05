// Petit utilitaire partagé par les backends : lire le contenu d'un canvas en PNG.
// Sert au « save image » (export pleine qualité). Sans dépendance à un backend
// particulier : les deux renderers dessinent dans un canvas, puis appellent ceci.

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Export PNG échoué (toBlob a renvoyé null)"));
      }
    }, "image/png");
  });
}
