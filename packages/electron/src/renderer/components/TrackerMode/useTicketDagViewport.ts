import { useCallback, useEffect, useRef } from 'react';

interface Camera { x: number; y: number; zoom: number }
const clampZoom = (value: number) => Math.max(0.08, Math.min(2.5, value));

/** Pan updates one SVG transform, keeping pointer movement out of React renders. */
export function useTicketDagViewport(width: number, height: number) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SVGGElement>(null);
  const percentRef = useRef<HTMLSpanElement>(null);
  const camera = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const bounds = useRef({ width, height });
  bounds.current = { width, height };

  const apply = useCallback((next: Camera) => {
    camera.current = next;
    sceneRef.current?.setAttribute('transform', `translate(${next.x},${next.y}) scale(${next.zoom})`);
    if (percentRef.current) percentRef.current.textContent = `${Math.round(next.zoom * 100)}%`;
  }, []);
  const zoomAt = useCallback((factor: number, x: number, y: number) => {
    const old = camera.current;
    const zoom = clampZoom(old.zoom * factor);
    apply({ zoom, x: x - (x - old.x) * zoom / old.zoom, y: y - (y - old.y) * zoom / old.zoom });
  }, [apply]);
  const zoomBy = useCallback((factor: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (rect) zoomAt(factor, rect.width / 2, rect.height / 2);
  }, [zoomAt]);
  const fit = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = Math.min(1, clampZoom(Math.min((rect.width - 32) / bounds.current.width, (rect.height - 32) / bounds.current.height)));
    apply({ zoom, x: (rect.width - bounds.current.width * zoom) / 2, y: (rect.height - bounds.current.height * zoom) / 2 });
  }, [apply]);
  const focus = useCallback((box: { x: number; y: number; width: number; height: number }) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = Math.max(0.85, camera.current.zoom);
    apply({ zoom, x: Math.min(24, rect.width / 2 - (box.x + box.width / 2) * zoom), y: Math.min(24, rect.height / 2 - (box.y + box.height / 2) * zoom) });
  }, [apply]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let drag: { id: number; x: number; y: number; camera: Camera; moved: boolean } | null = null;
    let suppressClick = false;
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      suppressClick = false;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, camera: { ...camera.current }, moved: false };
      if (!(event.target instanceof Element && event.target.closest('button'))) { viewport.focus(); event.preventDefault(); }
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.moved) {
        if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) <= 4) return;
        drag.moved = true;
        suppressClick = true;
        viewport.setPointerCapture(event.pointerId);
        viewport.dataset.dragging = 'true';
        viewport.focus();
      }
      apply({ ...drag.camera, x: drag.camera.x + event.clientX - drag.x, y: drag.camera.y + event.clientY - drag.y });
    };
    const up = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      drag = null;
      delete viewport.dataset.dragging;
      if (event.type === 'pointercancel') suppressClick = false;
    };
    const click = (event: MouseEvent) => {
      if (suppressClick && event.detail > 0) { event.preventDefault(); event.stopPropagation(); suppressClick = false; }
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        const rect = viewport.getBoundingClientRect();
        zoomAt(Math.exp(-event.deltaY * multiplier * 0.01), event.clientX - rect.left, event.clientY - rect.top);
      } else apply({ ...camera.current, x: camera.current.x - event.deltaX * multiplier, y: camera.current.y - event.deltaY * multiplier });
    };
    const key = (event: KeyboardEvent) => {
      if (event.target !== viewport) return;
      const shifts: Record<string, [number, number]> = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };
      const shift = shifts[event.key];
      if (shift) { event.preventDefault(); apply({ ...camera.current, x: camera.current.x + shift[0], y: camera.current.y + shift[1] }); }
      else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.2); }
      else if (event.key === '-') { event.preventDefault(); zoomBy(1 / 1.2); }
      else if (event.key === '0') { event.preventDefault(); fit(); }
    };
    viewport.addEventListener('pointerdown', down);
    viewport.addEventListener('pointermove', move);
    viewport.addEventListener('pointerup', up);
    viewport.addEventListener('pointercancel', up);
    viewport.addEventListener('click', click, true);
    viewport.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('keydown', key);
    return () => {
      viewport.removeEventListener('pointerdown', down);
      viewport.removeEventListener('pointermove', move);
      viewport.removeEventListener('pointerup', up);
      viewport.removeEventListener('pointercancel', up);
      viewport.removeEventListener('click', click, true);
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('keydown', key);
    };
  }, [apply, fit, zoomAt, zoomBy]);
  return { viewportRef, sceneRef, percentRef, zoomBy, fit, focus };
}
