import { useCallback, useLayoutEffect, useRef } from 'react';
import type { FocusEventHandler } from 'react';

/** Preserve a panel's keyboard position across disabled or removed controls.
 * User focus/pointer movement wins over recovery; no action is replayed. */
export function useFocusRecovery() {
  const rootRef = useRef<HTMLElement>(null);
  const anchorRef = useRef<HTMLHeadingElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const parked = useRef(false);
  const interrupted = useRef(false);
  const pendingBlur = useRef<{ element: HTMLElement } | null>(null);
  const recovering = useRef(false);
  const recover = useCallback(() => {
    const root = rootRef.current, anchor = anchorRef.current, previous = origin.current;
    if (!root || !anchor || !previous) return;
    if (pendingBlur.current?.element === previous) {
      pendingBlur.current = null;
      // React can emit focusout just before removing an enabled control.
      // A still-connected origin instead means a deliberate blur; even a
      // later disabled state must not reclaim that abandoned keyboard position.
      if (root.contains(previous)) {
        origin.current = null; parked.current = false; interrupted.current = false;
        return;
      }
    }
    const doc = root.ownerDocument, active = doc.activeElement;
    // A user who tabs/clicks elsewhere must not be pulled back after I/O.
    if (active !== doc.body && active !== previous && !(parked.current && active === anchor)) return;
    const available = root.contains(previous) && !previous.matches(':disabled') && !previous.closest('[hidden], [inert]');
    // A native dialog may own focus throughout the disabled interval. Remember
    // that observed interruption without focusing into a background document.
    if (!available) interrupted.current = true;
    if (!doc.hasFocus()) return;
    if (available && active === previous) { interrupted.current = false; return; }
    const target = available ? (parked.current || interrupted.current ? previous : null) : anchor;
    if (!target || active === target) return;
    recovering.current = true;
    try {
      target.focus();
      parked.current = target === anchor;
      interrupted.current = false;
      pendingBlur.current = null;
      if (!root.contains(previous)) origin.current = null;
    } finally { recovering.current = false; }
  }, []);
  const onFocusCapture: FocusEventHandler<HTMLElement> = event => {
    if (!recovering.current && event.target instanceof HTMLElement) {
      origin.current = event.target;
      parked.current = false;
      interrupted.current = false;
      pendingBlur.current = null;
    }
  };
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const doc = root.ownerDocument, win = doc.defaultView;
    let live = true;
    const clear = () => { origin.current = null; parked.current = false; interrupted.current = false; pendingBlur.current = null; };
    const focused = (event: FocusEvent) => {
      if (event.target instanceof Node && event.target !== doc.body && !root.contains(event.target)) clear();
    };
    const blurred = (event: FocusEvent) => {
      const previous = origin.current;
      if (recovering.current) return;
      if (parked.current && event.target === anchorRef.current) { clear(); return; }
      if (!previous || event.target !== previous) return;
      // A browser may blur immediately when React disables a control, before
      // the layout effect can observe it. An enabled control deliberately
      // blurred by the user or another workflow no longer owns recovery.
      if (!root.contains(previous) || previous.matches(':disabled') || previous.closest('[hidden], [inert]'))
        interrupted.current = true;
      else {
        const pending = { element: previous };
        pendingBlur.current = pending;
        queueMicrotask(() => {
          if (!live || pendingBlur.current !== pending || origin.current !== previous) return;
          if (root.contains(previous)) clear();
          else recover();
        });
      }
    };
    const pointed = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !origin.current?.contains(event.target)) clear();
    };
    const returned = () => { queueMicrotask(() => { if (live) recover(); }); };
    doc.addEventListener('focusin', focused, true);
    doc.addEventListener('focusout', blurred, true);
    doc.addEventListener('pointerdown', pointed, true);
    win?.addEventListener('focus', returned);
    return () => {
      live = false; clear();
      doc.removeEventListener('focusin', focused, true);
      doc.removeEventListener('focusout', blurred, true);
      doc.removeEventListener('pointerdown', pointed, true);
      win?.removeEventListener('focus', returned);
    };
  }, [recover]);
  useLayoutEffect(recover);
  return { rootRef, anchorRef, onFocusCapture };
}
