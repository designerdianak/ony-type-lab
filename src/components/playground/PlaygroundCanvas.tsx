import { useEffect, useRef } from 'react';
import type opentype from 'opentype.js';
import { createModeController } from '../../modes/factory';
import type { ModeSnapshot } from '../../modes/types';
import type { LabModeId } from '../../types/playground';
import type { PlaygroundVisualState } from '../../types/playground';
import { setupHiDpiCanvas } from '../../utils/canvas';
import { useCanvasTextInput } from '../../hooks/useCanvasTextInput';

export type PlaygroundCanvasProps = {
  mode: LabModeId;
  text: string;
  fontCss: string;
  fontUrl: string;
  fontReady: boolean;
  fontSize: number;
  letterSpacing: number;
  lineHeight: number;
  visual: PlaygroundVisualState;
  animationEnabled: boolean;
  opentypeFont: opentype.Font | null;
  onCanvasReady?: (el: HTMLCanvasElement) => void;
  onTextChange?: (text: string) => void;
  forceUppercase?: boolean;
  stageRef?: React.RefObject<HTMLElement | null>;
};

export function PlaygroundCanvas({
  mode,
  text,
  fontCss,
  fontUrl,
  fontReady,
  fontSize,
  letterSpacing,
  lineHeight,
  visual,
  animationEnabled,
  opentypeFont,
  onCanvasReady,
  onTextChange,
  forceUppercase = false,
  stageRef,
}: PlaygroundCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const localStageRef = useRef<HTMLDivElement | null>(null);
  const focusRef = stageRef ?? localStageRef;
  const controllerRef = useRef<ReturnType<typeof createModeController> | null>(null);
  const dataRef = useRef({
    mode,
    text,
    fontCss,
    fontUrl,
    fontSize,
    letterSpacing,
    lineHeight,
    visual,
    animationEnabled,
    opentypeFont,
    w: 1,
    h: 1,
  });

  dataRef.current = {
    mode,
    text,
    fontCss,
    fontUrl,
    fontSize,
    letterSpacing,
    lineHeight,
    visual,
    animationEnabled,
    opentypeFont,
    w: dataRef.current.w,
    h: dataRef.current.h,
  };

  useCanvasTextInput({
    text,
    onTextChange: onTextChange ?? (() => {}),
    forceUppercase,
    enabled: fontReady && Boolean(onTextChange),
    containerRef: focusRef,
  });

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    onCanvasReady?.(el);
  }, [onCanvasReady]);

  useEffect(() => {
    if (!fontReady) return;
    const onSpaceStop = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (e.repeat) return;
      if (e.target instanceof HTMLElement && e.target.closest('.lab__panel')) return;
      e.preventDefault();
      controllerRef.current?.interruptInteraction();
    };
    window.addEventListener('keydown', onSpaceStop);
    return () => window.removeEventListener('keydown', onSpaceStop);
  }, [fontReady]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !fontReady) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const { width, height } = setupHiDpiCanvas(canvas, ctx);
      dataRef.current.w = width;
      dataRef.current.h = height;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    window.addEventListener('resize', resize);

    const getSnap = (): ModeSnapshot => {
      const d = dataRef.current;
      return {
        w: d.w,
        h: d.h,
        mode: d.mode,
        text: d.text,
        fontCss: d.fontCss,
        fontUrl: d.fontUrl,
        fontSize: d.fontSize,
        letterSpacing: d.letterSpacing,
        lineHeight: d.lineHeight,
        visual: d.visual,
        animationEnabled: d.animationEnabled,
        opentypeFont: d.opentypeFont,
      };
    };

    controllerRef.current?.dispose();
    controllerRef.current = createModeController(dataRef.current.mode, canvas, ctx, getSnap);
    controllerRef.current.start();

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', resize);
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, [mode, fontReady]);

  return (
    <div ref={localStageRef} className="lab__canvas-wrap" tabIndex={-1}>
      <canvas ref={canvasRef} className="lab__canvas" />
    </div>
  );
}
