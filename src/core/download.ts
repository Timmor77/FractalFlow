// Offers a blob to the user as a file download.

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // The click only queues the download: revoking in the same task can cancel
  // it in some browsers, so let it start first.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
