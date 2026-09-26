import { useId, useState } from 'react';
import { Plus } from 'lucide-react';
import { PACK_LIMITS, QUICK_EMOJI, parseEmojiInput } from '../lib/packModel';
import { toSafeErrorMessage } from '../lib/stickerModel';

/**
 * Quick emoji palette plus a free text field (any emoji, e.g. from Win + .).
 * `onChange(emoji)` saves and may throw; the typed value stays on failure.
 */
export function EmojiPicker({ value, onChange, disabled = false, label = 'Emoji' }) {
  const inputId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState(value.join(' '));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const commit = async (emoji) => {
    setSaving(true);
    setError('');
    try {
      await onChange(emoji);
      setDraft(emoji.join(' '));
    } catch (saveError) {
      setError(toSafeErrorMessage(saveError.message));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (emoji) => {
    const next = value.includes(emoji) ? value.filter((item) => item !== emoji) : [...value, emoji];
    if (next.length > PACK_LIMITS.maxEmoji) {
      setError(`A sticker can have at most ${PACK_LIMITS.maxEmoji} emoji.`);
      return;
    }
    commit(next);
  };

  const submitDraft = () => {
    const parsed = parseEmojiInput(draft);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    if (parsed.emoji.join(' ') === value.join(' ')) return;
    commit(parsed.emoji);
  };

  const busy = disabled || saving;
  return (
    <div className="emoji-picker">
      <div className="emoji-palette" role="group" aria-label="Quick emoji">
        {QUICK_EMOJI.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="emoji-option"
            aria-pressed={value.includes(emoji)}
            disabled={busy}
            onClick={() => toggle(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      <label htmlFor={inputId} className="emoji-label">{label}</label>
      <div className="emoji-field">
        <input
          id={inputId}
          className="text-input"
          value={draft}
          disabled={busy}
          aria-describedby={hintId}
          aria-invalid={Boolean(error)}
          autoComplete="off"
          onChange={(event) => { setDraft(event.target.value); setError(''); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitDraft();
            }
          }}
        />
        <button type="button" className="btn" disabled={busy} onClick={submitDraft}>Set</button>
      </div>
      <p id={hintId} className="muted small">
        Type or paste any emoji — on Windows press Win + . for the emoji panel. Up to {PACK_LIMITS.maxEmoji}; the first one matters most in Telegram.
      </p>
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}

export function NewPackForm({ onCreate, submitLabel = 'Create pack' }) {
  const inputId = useId();
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (!title.trim()) {
      setError('Give the pack a title.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onCreate(title);
      setTitle('');
    } catch (createError) {
      setError(toSafeErrorMessage(createError.message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="new-pack-form" onSubmit={submit}>
      <label htmlFor={inputId} className="sr-only">New pack title</label>
      <input
        id={inputId}
        className="text-input"
        placeholder="New pack title"
        maxLength={PACK_LIMITS.titleLength}
        value={title}
        onChange={(event) => { setTitle(event.target.value); setError(''); }}
      />
      <button type="submit" className="btn" disabled={saving}>
        <Plus size={16} aria-hidden="true" /> {submitLabel}
      </button>
      {error && <p className="field-error" role="alert">{error}</p>}
    </form>
  );
}
