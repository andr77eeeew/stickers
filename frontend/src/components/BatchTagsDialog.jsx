import { useId, useState } from 'react';
import { Sheet } from './Sheet';
import { describeFailure } from '../lib/jobModel';

const parseTags = (value) => [...new Set(value.split(',').map((tag) => tag.toLowerCase().trim()).filter(Boolean))];

export function BatchTagsDialog({ open, onClose, count, onSubmit }) {
  const titleId = useId();
  const addId = useId();
  const removeId = useId();
  const [add, setAdd] = useState('');
  const [remove, setRemove] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const addTags = parseTags(add);
  const removeTags = parseTags(remove);
  const systemTag = [...addTags, ...removeTags].some((tag) => tag.startsWith('import:'));

  const close = () => {
    setAdd('');
    setRemove('');
    setError('');
    setResult(null);
    onClose();
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setResult(await onSubmit(addTags, removeTags));
    } catch (submitError) {
      setError(describeFailure(submitError.message));
    } finally {
      setBusy(false);
    }
  };

  const problems = result?.items.filter((item) => item.state !== 'succeeded') || [];

  return (
    <Sheet open={open} onClose={close} className="sheet sheet-dialog" labelledBy={titleId}>
      <h2 id={titleId}>Tags for {count} sticker{count === 1 ? '' : 's'}</h2>
      {result ? (
        <>
          <p role="status">
            Updated {result.counts.succeeded} of {result.counts.total}.
            {problems.length > 0 && ` ${problems.length} could not be updated.`}
          </p>
          {problems.length > 0 && (
            <ul className="plain-list small">
              {problems.map((item) => (
                <li key={item.stickerId}><span className="mono">{item.stickerId.slice(0, 8)}</span> — {describeFailure(item.error)}</li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn btn-primary" onClick={close}>Done</button>
          </div>
        </>
      ) : (
        <form className="dialog-form" onSubmit={submit}>
          <label htmlFor={addId}>Add tags</label>
          <input id={addId} className="text-input" value={add} placeholder="reaction, cat" onChange={(event) => setAdd(event.target.value)} autoComplete="off" />
          <label htmlFor={removeId}>Remove tags</label>
          <input id={removeId} className="text-input" value={remove} placeholder="old-tag" onChange={(event) => setRemove(event.target.value)} autoComplete="off" />
          <p className="muted small">Separate tags with commas. Import tags are kept automatically.</p>
          {systemTag && <p className="field-error">Tags starting with “import:” are managed by the app.</p>}
          {error && <p className="field-error" role="alert">{error} Your input is kept — try again.</p>}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || systemTag || (!addTags.length && !removeTags.length)}>
              {busy ? 'Saving…' : 'Apply'}
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
