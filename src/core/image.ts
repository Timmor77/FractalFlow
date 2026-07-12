// Small utility shared by the backends: read a canvas's content as a PNG.
// Used by "save image" (full-quality export). No dependency on any particular
// backend: both renderers draw into a canvas, then call this.

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("PNG export failed (toBlob returned null)"));
      }
    }, "image/png");
  });
}
