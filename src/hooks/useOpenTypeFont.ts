import { useEffect, useState } from 'react';
import opentype from 'opentype.js';

export function useOpenTypeFont(fontUrl: string | null) {
  const [font, setFont] = useState<opentype.Font | null>(null);
  useEffect(() => {
    if (!fontUrl) return;
    let cancelled = false;
    opentype.load(fontUrl).then((f) => {
      if (!cancelled) setFont(f);
    });
    return () => {
      cancelled = true;
    };
  }, [fontUrl]);
  return font;
}
