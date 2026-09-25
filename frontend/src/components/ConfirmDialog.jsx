import { useId } from 'react';
import { Sheet } from './Sheet';

export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = 'Cancel', onConfirm, onCancel }) {
  const titleId = useId();
  return (
    <Sheet open={open} onClose={onCancel} className="sheet sheet-dialog" labelledBy={titleId}>
      <h2 id={titleId}>{title}</h2>
      {children}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className="btn btn-primary" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Sheet>
  );
}
