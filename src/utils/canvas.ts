export function setupHiDpiCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { dpr, width: rect.width, height: rect.height };
}

export function clearNeutral(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  ctx.fillStyle = '#f4f3f0';
  ctx.fillRect(0, 0, w, h);
}

export function applyMultiplyBlend(ctx: CanvasRenderingContext2D, enabled: boolean) {
  ctx.globalCompositeOperation = enabled ? 'multiply' : 'source-over';
}
