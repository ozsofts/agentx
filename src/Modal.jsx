import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

const layers = [];
const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
let unlockPage;

// Keep dialogs outside app scroll containers and lock only background scrolling.
export default function Modal({ children, onClose }) {
  const backdrop = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const layer = backdrop.current;
    const previousFocus = document.activeElement;
    const dialog = layer.querySelector('[role="dialog"]');
    dialog.tabIndex = -1;
    if (!layers.length) {
      const root = document.getElementById("root");
      const previousInert = root.inert;
      const scroll = [window.scrollX, window.scrollY];
      const styles = [document.documentElement, document.body].map((element) => {
        const previous = [element.style.overflow, element.style.overscrollBehavior];
        element.style.overflow = "hidden";
        element.style.overscrollBehavior = "none";
        return () => { [element.style.overflow, element.style.overscrollBehavior] = previous; };
      });
      root.inert = true;
      unlockPage = () => { styles.forEach((restore) => restore()); root.inert = previousInert; window.scrollTo(...scroll); };
    }
    if (layers.length) layers.at(-1).inert = true;
    layers.push(layer);
    const top = () => layers.at(-1) === layer;
    const controls = () => [...dialog.querySelectorAll(focusable)].filter((element) => element.getClientRects().length && !element.closest('[hidden], [inert]'));
    const focus = () => (controls()[0] || dialog).focus({ preventScroll: true });
    if (!layer.contains(document.activeElement)) focus();
    const keydown = (event) => {
      if (!top()) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); close.current?.();
      } else if (event.key === "Tab") {
        const elements = controls();
        const first = elements[0];
        const last = elements.at(-1);
        if (!first || !dialog.contains(document.activeElement) || document.activeElement === dialog || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault(); (event.shiftKey ? last || dialog : first || dialog).focus({ preventScroll: true });
        }
      }
    };
    const focusin = (event) => { if (top() && !layer.contains(event.target)) focus(); };
    const blockBackgroundScroll = (event) => { if (!dialog.contains(event.target)) event.preventDefault(); };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin);
    layer.addEventListener("wheel", blockBackgroundScroll, { passive: false });
    layer.addEventListener("touchmove", blockBackgroundScroll, { passive: false });
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin);
      layer.removeEventListener("wheel", blockBackgroundScroll);
      layer.removeEventListener("touchmove", blockBackgroundScroll);
      layers.splice(layers.indexOf(layer), 1);
      if (layers.length) layers.at(-1).inert = false;
      else { unlockPage?.(); unlockPage = null; }
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(<div ref={backdrop} className="modal-backdrop" role="presentation">{children}</div>, document.body);
}
