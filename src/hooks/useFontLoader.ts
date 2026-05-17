import { useEffect, useState } from 'react';
import { fontUrlForFile } from '../config/fontRegistry';

export function useFontLoader(cssFamily: string, file: string, cssWeight: string) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);
    const url = fontUrlForFile(file);
    const face = new FontFace(cssFamily, `url(${encodeURI(url)})`, {
      weight: cssWeight,
      style: 'normal',
    });
    face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError('font');
      });
    return () => {
      cancelled = true;
    };
  }, [cssFamily, file, cssWeight]);

  return { ready, error, fontUrl: fontUrlForFile(file) };
}
