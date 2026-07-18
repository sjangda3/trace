import { useEffect, useRef } from "react";
import { AppearanceControls } from "./AppearanceControls";
import type { ResolvedAppearance, TracePreferences } from "./types";

export function PreferencesDialog({
  open,
  preferences,
  resolvedAppearance,
  saveError,
  onPreferencesChange,
  onClose,
}: {
  open: boolean;
  preferences: TracePreferences;
  resolvedAppearance: ResolvedAppearance;
  saveError: string | null;
  onPreferencesChange: (next: TracePreferences) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      }
      queueMicrotask(() => headingRef.current?.focus());
      return;
    }

    if (dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => {
      if (open) onClose();
      queueMicrotask(() => returnFocusRef.current?.focus());
    };
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener("close", handleClose);
    dialog.addEventListener("cancel", handleCancel);
    return () => {
      dialog.removeEventListener("close", handleClose);
      dialog.removeEventListener("cancel", handleCancel);
    };
  }, [onClose, open]);

  return (
    <dialog
      ref={dialogRef}
      className="preferences-dialog"
      aria-labelledby="preferences-dialog-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="preferences-dialog__content">
        <header className="preferences-dialog__heading">
          <div>
            <h2 id="preferences-dialog-title" ref={headingRef} tabIndex={-1}>Preferences</h2>
            <p>Appearance settings are saved on this Mac.</p>
          </div>
          <button type="button" className="preferences-dialog__done" onClick={onClose}>Done</button>
        </header>
        <AppearanceControls
          className="appearance-controls--preferences"
          value={preferences}
          resolvedAppearance={resolvedAppearance}
          onChange={onPreferencesChange}
        />
        {saveError ? <p className="preferences-dialog__error" role="status">{saveError}</p> : null}
      </div>
    </dialog>
  );
}
