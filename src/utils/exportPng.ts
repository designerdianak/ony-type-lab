export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.rel = 'noopener';
  a.click();
}

export function exportCanvasPng(canvas: HTMLCanvasElement, name = 'ony-lab.png') {
  const url = canvas.toDataURL('image/png');
  downloadDataUrl(url, name);
}
