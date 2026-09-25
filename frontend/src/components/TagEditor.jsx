import { useId, useState } from 'react';
import { X } from 'lucide-react';

const normalizeTag = (value) => value.toLowerCase().trim().slice(0, 40);

export function TagEditor({ initialTags, onSave }) {
  const [tags, setTags] = useState(initialTags);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inputId = useId();
  const errorId = useId();

  const pending = draft.split(',').map(normalizeTag).filter(Boolean);
  const nextTags = [...new Set([...tags, ...pending])];
  const dirty = JSON.stringify(nextTags) !== JSON.stringify(initialTags);

  const commitDraft = () => {
    if (!pending.length) return;
    setTags(nextTags);
    setDraft('');
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await onSave(nextTags);
      setTags(nextTags);
      setDraft('');
    } catch (saveError) {
      setError(`${saveError.message}. Your tags are kept here — try again.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tag-editor">
      <div className="tag-input">
        {tags.map((tag) => (
          <span key={tag} className="tag-chip">
            {tag}
            <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => setTags(tags.filter((item) => item !== tag))}>
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        <label className="sr-only" htmlFor={inputId}>Add tag</label>
        <input
          id={inputId}
          value={draft}
          placeholder={tags.length ? 'Add tag' : 'Add tag, press Enter'}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (pending.length) commitDraft();
              else if (dirty) save();
            } else if (event.key === 'Backspace' && !draft && tags.length) {
              setTags(tags.slice(0, -1));
            }
          }}
        />
      </div>
      <div className="tag-actions">
        <button type="button" className="btn btn-small" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save tags'}
        </button>
        {dirty && !saving && (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => { setTags(initialTags); setDraft(''); setError(''); }}>
            Reset
          </button>
        )}
      </div>
      {error && <p className="field-error" id={errorId} role="alert">{error}</p>}
    </div>
  );
}
