import { useEffect, useRef } from 'react';

/**
 * Native <dialog> wrapper: modal focus handling, Escape and backdrop close,
 * and focus return to the opener come from the platform.
 */
export function Sheet({ open, onClose, className = '', labelledBy, children }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className={className}
      aria-labelledby={labelledBy}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === dialogRef.current) onClose(); }}
    >
      {open && children}
    </dialog>
  );
}
