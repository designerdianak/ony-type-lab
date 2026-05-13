export interface GlyphLayout {
  char: string;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  baseline: number;
}

export function layoutGlyphs(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontCss: string,
  fontSize: number,
  letterSpacingPx: number,
  originX: number,
  originY: number,
): GlyphLayout[] {
  ctx.save();
  ctx.font = fontCss;
  ctx.textBaseline = 'alphabetic';
  const layouts: GlyphLayout[] = [];
  let x = originX;
  const metrics = ctx.measureText('M');
  const approxAscent =
    metrics.actualBoundingBoxAscent > 0 ? metrics.actualBoundingBoxAscent : fontSize * 0.72;
  const approxDescent =
    metrics.actualBoundingBoxDescent > 0 ? metrics.actualBoundingBoxDescent : fontSize * 0.22;
  const h = approxAscent + approxDescent;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? '';
    if (char === ' ') {
      const w = ctx.measureText(' ').width + letterSpacingPx;
      x += w;
      continue;
    }
    if (char === '\n') {
      continue;
    }
    const w = ctx.measureText(char).width;
    layouts.push({
      char,
      index: i,
      x,
      y: originY,
      w,
      h,
      baseline: originY,
    });
    x += w + letterSpacingPx;
  }
  ctx.restore();
  return layouts;
}

export function buildCanvasFont(cssFamily: string, cssWeight: string, size: number): string {
  return `${cssWeight} ${size}px "${cssFamily}"`;
}

export function measureLineWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontCss: string,
  letterSpacingPx: number,
): number {
  ctx.save();
  ctx.font = fontCss;
  let x = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (ch === '\n') continue;
    const w = ctx.measureText(ch).width;
    x += w + letterSpacingPx;
  }
  ctx.restore();
  return x;
}
