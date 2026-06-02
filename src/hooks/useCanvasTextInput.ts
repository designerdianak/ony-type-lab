import { useEffect, useRef } from 'react';

const MAX_LEN = 120;

export function useCanvasTextInput(options: {
  text: string;
  onTextChange: (t: string) => void;
  forceUppercase: boolean;
  enabled: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const { text, onTextChange, forceUppercase, enabled, containerRef } = options;
  const startedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('.lab__panel')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Tab' || e.key === 'Escape') return;

      if (e.key === 'Backspace') {
        e.preventDefault();
        startedRef.current = true;
        onTextChange(text.slice(0, -1));
        return;
      }

      if (e.key === 'Enter') return;

      if (e.key.length === 1) {
        e.preventDefault();
        startedRef.current = true;
        let ch = e.key;
        if (forceUppercase) ch = ch.toUpperCase();
        if (text.length >= MAX_LEN) return;
        onTextChange(text + ch);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [text, onTextChange, forceUppercase, enabled]);

  useEffect(() => {
    if (!enabled) return;
    containerRef.current?.focus({ preventScroll: true });
  }, [enabled, containerRef]);

  return { typingStarted: startedRef };
}
