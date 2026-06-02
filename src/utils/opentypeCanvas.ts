import type opentype from 'opentype.js';

function tracePath(ctx: CanvasRenderingContext2D, path: opentype.Path) {
  ctx.beginPath();
  for (const cmd of path.commands) {
    switch (cmd.type) {
      case 'M':
        ctx.moveTo(cmd.x, cmd.y);
        break;
      case 'L':
        ctx.lineTo(cmd.x, cmd.y);
        break;
      case 'C':
        ctx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
        break;
      case 'Q':
        ctx.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y);
        break;
      case 'Z':
        ctx.closePath();
        break;
      default:
        break;
    }
  }
}

/** Обводка контура глифа opentype (без заливки). */
export function strokeGlyphPath(
  ctx: CanvasRenderingContext2D,
  path: opentype.Path,
  stroke: string,
  lineWidth: number,
) {
  tracePath(ctx, path);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

/** Заливка контура глифа. */
export function fillGlyphPath(ctx: CanvasRenderingContext2D, path: opentype.Path, fill: string) {
  tracePath(ctx, path);
  ctx.fillStyle = fill;
  ctx.fill();
}
