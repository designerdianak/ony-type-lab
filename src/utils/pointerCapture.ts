/** Снимает захват указателя, если он был установлен для этого id (без исключений в консоль). */
export function safeReleasePointerCapture(canvas: HTMLCanvasElement, pointerId: number | null): void {
  if (pointerId == null) return;
  try {
    if (canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
  } catch {
    /* элемент не держит этот pointerId */
  }
}
