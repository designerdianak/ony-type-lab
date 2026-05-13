import opentype from 'opentype.js';
import type { GlyphLayout } from './textLayout';

export async function exportStaticSvg(options: {
  fontUrl: string;
  layouts: GlyphLayout[];
  fontSize: number;
  width: number;
  height: number;
  fill: string;
  multiplyBlend: boolean;
  stageBackground?: string;
}): Promise<string> {
  const font = await opentype.load(options.fontUrl);
  const paths: string[] = [];
  for (const g of options.layouts) {
    const p = font.getPath(g.char, g.x, g.baseline, options.fontSize);
    paths.push(p.toSVG(2));
  }
  const blend = options.multiplyBlend ? 'multiply' : 'normal';
  const bg = options.stageBackground ?? '#f4f3f0';
  const rect =
    bg === 'transparent'
      ? ''
      : `<rect width="100%" height="100%" fill="${bg.replace(/"/g, '&quot;')}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}" viewBox="0 0 ${options.width} ${options.height}">
  ${rect}
  <g style="mix-blend-mode: ${blend}; fill: ${options.fill};">
    ${paths.join('\n')}
  </g>
</svg>`;
}

export function downloadTextFile(content: string, filename: string, mime = 'image/svg+xml') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.click();
  URL.revokeObjectURL(url);
}
