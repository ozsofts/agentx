import { useLayoutEffect, useRef, useState } from "react";

const storageKey = "pi-desktop.work-panel-width";
const minimumWidth = 320;
const chatMinimumWidth = 360;

export default function usePanelResize(panelRef) {
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem(storageKey));
      return Number.isFinite(saved) && saved >= minimumWidth && saved <= 4000 ? saved : null;
    } catch { return null; }
  });
  const [bounds, setBounds] = useState({ min: minimumWidth, max: 640, defaultWidth: 420, overlay: false });
  const [dragging, setDragging] = useState(false);
  const drag = useRef(null);
  const width = Math.min(bounds.max, Math.max(bounds.min, preferredWidth ?? bounds.defaultWidth));

  useLayoutEffect(() => {
    const parent = panelRef.current.parentElement;
    const measure = () => {
      const available = parent.clientWidth;
      if (!available) return; // Management hides, but preserves, the chat DOM.
      const overlay = window.innerWidth <= 900 || available < minimumWidth + chatMinimumWidth;
      const max = overlay ? Math.max(1, available - 24) : Math.max(minimumWidth, available - chatMinimumWidth);
      const min = Math.min(minimumWidth, max);
      const defaultWidth = Math.min(max, Math.max(min, overlay ? 420 : Math.min(640, Math.max(420, window.innerWidth * 0.4))));
      setBounds((current) => current.min === min && current.max === max && current.defaultWidth === defaultWidth && current.overlay === overlay ? current : { min, max, defaultWidth, overlay });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    window.addEventListener("resize", measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [panelRef]);

  function remember(next) {
    const clamped = Math.min(bounds.max, Math.max(bounds.min, Math.round(next)));
    setPreferredWidth(clamped);
    return clamped;
  }
  function save(value) {
    try {
      if (value === null) window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, String(value));
    } catch { /* Resizing remains available when storage is disabled. */ }
  }
  function finish(event) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    save(drag.current.lastWidth);
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return {
    width, bounds, dragging,
    handleProps: {
      onPointerDown(event) {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width, lastWidth: width };
        setDragging(true);
      },
      onPointerMove(event) {
        if (!drag.current || drag.current.pointerId !== event.pointerId) return;
        drag.current.lastWidth = remember(drag.current.width + drag.current.x - event.clientX);
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
      onDoubleClick() { setPreferredWidth(null); save(null); },
      onKeyDown(event) {
        const step = event.shiftKey ? 64 : 16;
        const next = { ArrowLeft: width + step, ArrowRight: width - step, Home: bounds.min, End: bounds.max }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        save(remember(next));
      },
    },
  };
}
