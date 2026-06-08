export interface GlyphLayout {
  char: string;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  baseline: number;
}

export type TextContainerRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type TextBlockLayout = {
  glyphs: GlyphLayout[];
  /** кегль после авто-подгонки под контейнер */
  effectiveFontSize: number;
  effectiveFontCss: string;
  container: TextContainerRect;
  lines: string[];
  lineCount: number;
};

const MARGIN_X = 0.1;
const MARGIN_Y = 0.11;
const LINE_HEIGHT_RATIO = 1.14;
/** после этой строки начинаем уменьшать кегль */
const MAX_LINES = 3;
const MIN_FONT_SCALE = 0.26;

export function buildCanvasFont(cssFamily: string, cssWeight: string, size: number): string {
  return `${cssWeight} ${size}px "${cssFamily}"`;
}

export function fontCssAtSize(fontCss: string, fontSize: number): string {
  return fontCss.replace(/(\d+(?:\.\d+)?)px/, `${fontSize}px`);
}

function textContainer(canvasW: number, canvasH: number): TextContainerRect {
  const mx = canvasW * MARGIN_X;
  const my = canvasH * MARGIN_Y;
  return {
    x: mx,
    y: my,
    w: Math.max(32, canvasW - mx * 2),
    h: Math.max(32, canvasH - my * 2),
  };
}

function fontMetrics(ctx: CanvasRenderingContext2D, fontCss: string, fontSize: number) {
  ctx.save();
  ctx.font = fontCss;
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText('Mg');
  const ascent = m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : fontSize * 0.72;
  const descent = m.actualBoundingBoxDescent > 0 ? m.actualBoundingBoxDescent : fontSize * 0.22;
  ctx.restore();
  return { ascent, descent, lineHeight: fontSize * LINE_HEIGHT_RATIO };
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
    x += ctx.measureText(ch).width + letterSpacingPx;
  }
  ctx.restore();
  return Math.max(0, x - (text.length > 0 ? letterSpacingPx : 0));
}

function wrapParagraph(
  ctx: CanvasRenderingContext2D,
  paragraph: string,
  fontCss: string,
  letterSpacingPx: number,
  maxWidth: number,
): string[] {
  const trimmed = paragraph.trim();
  if (!trimmed) return [''];

  const words = trimmed.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  const fits = (s: string) => !s || measureLineWidth(ctx, s, fontCss, letterSpacingPx) <= maxWidth;

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);

    if (!fits(word)) {
      let chunk = '';
      for (const ch of word) {
        const next = chunk + ch;
        if (fits(next) || !chunk) chunk = next;
        else {
          lines.push(chunk);
          chunk = ch;
        }
      }
      current = chunk;
    } else {
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function wrapTextToLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontCss: string,
  letterSpacingPx: number,
  maxWidth: number,
): string[] {
  const parts = text.split('\n');
  const lines: string[] = [];
  for (const part of parts) {
    lines.push(...wrapParagraph(ctx, part, fontCss, letterSpacingPx, maxWidth));
  }
  return lines.length ? lines : [''];
}

function layoutLinesFromText(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  fontCss: string,
  fontSize: number,
  letterSpacingPx: number,
  container: TextContainerRect,
): GlyphLayout[] {
  const { ascent, descent, lineHeight } = fontMetrics(ctx, fontCss, fontSize);
  const glyphH = ascent + descent;
  const blockH = lines.length * lineHeight;
  const blockTop = container.y + (container.h - blockH) * 0.5;

  const glyphs: GlyphLayout[] = [];
  let index = 0;

  ctx.save();
  ctx.font = fontCss;
  ctx.textBaseline = 'alphabetic';

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? '';
    const lineW = measureLineWidth(ctx, line, fontCss, letterSpacingPx);
    let x = container.x + (container.w - lineW) * 0.5;
    const baseline = blockTop + li * lineHeight + ascent;

    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci] ?? '';
      if (ch === ' ') {
        x += ctx.measureText(' ').width + letterSpacingPx;
        continue;
      }

      const w = ctx.measureText(ch).width;
      glyphs.push({
        char: ch,
        index: index++,
        x,
        y: baseline,
        w,
        h: glyphH,
        baseline,
      });
      x += w + letterSpacingPx;
    }
  }

  ctx.restore();
  return glyphs;
}

/**
 * Текст в центральном контейнере: перенос строк, вертикальное центрирование,
 * авто-уменьшение кегля при 4+ строках или переполнении.
 * Эффекты могут выходить за container — он только для вёрстки букв.
 */
export function layoutTextInContainer(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontCss: string,
  fontSize: number,
  letterSpacingPx: number,
  canvasW: number,
  canvasH: number,
): TextBlockLayout {
  const container = textContainer(canvasW, canvasH);
  const clean = text.trim();
  if (!clean) {
    return {
      glyphs: [],
      effectiveFontSize: fontSize,
      effectiveFontCss: fontCss,
      container,
      lines: [],
      lineCount: 0,
    };
  }

  let scale = 1;
  let effectiveFontSize = fontSize;
  let effectiveFontCss = fontCss;
  let lines: string[] = [''];

  while (scale >= MIN_FONT_SCALE) {
    effectiveFontSize = Math.max(10, fontSize * scale);
    effectiveFontCss = fontCssAtSize(fontCss, effectiveFontSize);
    lines = wrapTextToLines(ctx, clean, effectiveFontCss, letterSpacingPx, container.w);
    const { lineHeight } = fontMetrics(ctx, effectiveFontCss, effectiveFontSize);
    const blockH = lines.length * lineHeight;
    const tooMany = lines.length > MAX_LINES;
    const tooTall = blockH > container.h;
    if (!tooMany && !tooTall) break;

    if (tooTall) scale *= Math.max(MIN_FONT_SCALE / scale, (container.h / blockH) * 0.96);
    else scale *= 0.9;
  }

  const glyphs = layoutLinesFromText(
    ctx,
    lines,
    effectiveFontCss,
    effectiveFontSize,
    letterSpacingPx,
    container,
  );

  return {
    glyphs,
    effectiveFontSize,
    effectiveFontCss,
    container,
    lines,
    lineCount: lines.length,
  };
}

/** @deprecated используйте layoutTextInContainer */
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
      x += ctx.measureText(' ').width + letterSpacingPx;
      continue;
    }
    if (char === '\n') continue;
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

export function layoutTextForCanvas(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontCss: string,
  fontSize: number,
  letterSpacingPx: number,
  canvasW: number,
  canvasH: number,
): TextBlockLayout {
  return layoutTextInContainer(ctx, text, fontCss, fontSize, letterSpacingPx, canvasW, canvasH);
}
