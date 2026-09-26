import { useState } from 'react';
import {
  ArrowDown, ArrowUp, CircleAlert, CircleCheck, Download, GripVertical, LoaderCircle, Pencil, Trash2, X
} from 'lucide-react';
import { StickerMedia } from './StickerMedia';
import { ConfirmDialog } from './ConfirmDialog';
import { NewPackForm } from './PackControls';
import {
  BOT_COMMAND, KIND_LABELS, PACK_LIMITS, getItemProblems, moveItem, parseEmojiInput, summarizePack
} from '../lib/packModel';
import { getShortId, toSafeErrorMessage } from '../lib/stickerModel';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function RowEmoji({ item, onSave, position }) {
  const [draft, setDraft] = useState(item.emoji.join(' '));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const parsed = parseEmojiInput(draft);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    if (parsed.emoji.join(' ') === item.emoji.join(' ')) return;
    setSaving(true);
    try {
      await onSave(parsed.emoji);
      setError('');
    } catch (saveError) {
      setError(toSafeErrorMessage(saveError.message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pack-row-emoji">
      <input
        className="text-input emoji-input"
        value={draft}
        disabled={saving}
        aria-label={`Emoji for sticker ${position}`}
        aria-invalid={Boolean(error)}
        placeholder="Add emoji"
        autoComplete="off"
        onChange={(event) => { setDraft(event.target.value); setError(''); }}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
          }
        }}
      />
      {error && <span className="field-error small" role="alert">{error}</span>}
    </div>
  );
}

function PackDetail({
  pack, isActive, stickersById, packActions, onOpenSticker, onGoToLibrary, onAfterDelete
}) {
  const summary = summarizePack(pack, stickersById);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(pack.title);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const exporting = packActions.exportingId === pack.id;

  const run = async (task) => {
    setError('');
    try {
      await task();
      return true;
    } catch (actionError) {
      setError(toSafeErrorMessage(actionError.message));
      return false;
    }
  };

  const move = (from, to, focusKey) => run(async () => {
    await packActions.setItems(pack.id, moveItem(pack.items, from, to));
    // Reordering moves DOM nodes; put focus back on the control the user pressed.
    window.setTimeout(() => document.querySelector(`[data-focus-key="${focusKey}"]`)?.focus(), 0);
  });

  const submitRename = async (event) => {
    event.preventDefault();
    if (await run(() => packActions.renamePack(pack.id, title))) setRenaming(false);
  };

  return (
    <section className="pack-detail" aria-labelledby="pack-title">
      <div className="pack-detail-header">
        {renaming ? (
          <form className="new-pack-form" onSubmit={submitRename}>
            <label htmlFor="pack-rename" className="sr-only">Pack title</label>
            <input
              id="pack-rename"
              className="text-input"
              value={title}
              maxLength={PACK_LIMITS.titleLength}
              onChange={(event) => setTitle(event.target.value)}
            />
            <button type="submit" className="btn btn-primary">Save</button>
            <button type="button" className="btn" onClick={() => { setRenaming(false); setTitle(pack.title); }}>Cancel</button>
          </form>
        ) : (
          <div className="pack-heading">
            <h2 id="pack-title">{pack.title}</h2>
            <button type="button" className="icon-btn" aria-label="Rename pack" onClick={() => setRenaming(true)}>
              <Pencil size={16} aria-hidden="true" />
            </button>
          </div>
        )}
        <p className="muted small tabular">
          {summary.kind ? KIND_LABELS[summary.kind] : 'Empty pack'} · {summary.count}/{PACK_LIMITS.maxStickers} stickers
          {isActive ? ' · Current pack' : ''}
        </p>
        <div className="pack-detail-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={Boolean(summary.exportBlockedReason) || exporting}
            onClick={() => packActions.exportPack(pack.id)}
          >
            {exporting ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
            Export for @Stickers
          </button>
          {!isActive && (
            <button type="button" className="btn" onClick={() => run(() => packActions.activatePack(pack.id))}>Make current</button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={16} aria-hidden="true" /> Delete pack
          </button>
        </div>
      </div>

      <p className={`inline-alert ${summary.exportBlockedReason ? 'tone-warning' : 'tone-ok'}`} role="status">
        {summary.exportBlockedReason
          ? <><CircleAlert size={16} aria-hidden="true" /> {summary.exportBlockedReason} Export is available when every sticker is Ready and has an emoji.</>
          : <><CircleCheck size={16} aria-hidden="true" /> Ready to export: {plural(summary.count, 'sticker')} in this order with their emoji.</>}
      </p>
      {error && <p className="inline-alert tone-problem" role="alert">{error}</p>}

      {pack.items.length === 0 ? (
        <div className="state-panel">
          <h3>No stickers in this pack yet</h3>
          <p>{isActive
            ? 'Open a sticker in the library and pick an emoji, or select several and use Add to pack.'
            : 'Make this pack current, then add stickers from the library.'}</p>
          <button type="button" className="btn" onClick={onGoToLibrary}>Go to library</button>
        </div>
      ) : (
        <ol className="pack-items" aria-label={`Stickers in ${pack.title}, in order`}>
          {pack.items.map((item, index) => {
            const sticker = stickersById.get(item.stickerId);
            const problems = getItemProblems(item, sticker);
            const position = index + 1;
            return (
              <li
                key={item.stickerId}
                className={`pack-row ${dragIndex === index ? 'is-dragging' : ''} ${dropIndex === index && dragIndex !== index ? 'is-drop-target' : ''}`}
                draggable
                onDragStart={(event) => {
                  setDragIndex(index);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', item.stickerId);
                }}
                onDragOver={(event) => {
                  if (dragIndex === null) return;
                  event.preventDefault();
                  setDropIndex(index);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragIndex !== null && dragIndex !== index) run(() => packActions.setItems(pack.id, moveItem(pack.items, dragIndex, index)));
                  setDragIndex(null);
                  setDropIndex(null);
                }}
                onDragEnd={() => { setDragIndex(null); setDropIndex(null); }}
              >
                <GripVertical size={16} className="pack-row-grip" aria-hidden="true" />
                <span className="pack-row-number tabular">{String(position).padStart(3, '0')}</span>
                <button
                  type="button"
                  className="pack-row-thumb preview-surface"
                  aria-label={`Open sticker ${sticker ? getShortId(sticker) : position} in the library`}
                  disabled={!sticker}
                  onClick={() => onOpenSticker(item.stickerId)}
                >
                  {sticker ? <StickerMedia sticker={sticker} still /> : <span className="media-unavailable sticker-media" />}
                </button>
                <span className="pack-row-info">
                  <span className="mono small">{item.stickerId.slice(0, 8)}</span>
                  {problems.length
                    ? <span className="pack-row-problems">{problems.map((problem) => (
                      <span key={problem.code} className={`badge ${problem.code === 'no_emoji' ? 'badge-warning' : 'badge-problem'}`}>{problem.label}</span>
                    ))}</span>
                    : <span className="badge badge-ok">Ready</span>}
                </span>
                <RowEmoji
                  key={item.emoji.join('')}
                  item={item}
                  position={position}
                  onSave={(emoji) => packActions.setEmoji(pack.id, item.stickerId, emoji)}
                />
                <span className="pack-row-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    data-focus-key={`${item.stickerId}-up`}
                    aria-label={`Move sticker ${position} up`}
                    disabled={index === 0}
                    onClick={() => move(index, index - 1, `${item.stickerId}-up`)}
                  >
                    <ArrowUp size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    data-focus-key={`${item.stickerId}-down`}
                    aria-label={`Move sticker ${position} down`}
                    disabled={index === pack.items.length - 1}
                    onClick={() => move(index, index + 1, `${item.stickerId}-down`)}
                  >
                    <ArrowDown size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove sticker ${position} from the pack`}
                    onClick={() => run(() => packActions.removeSticker(pack.id, item.stickerId))}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <section className="panel pack-howto" aria-labelledby="pack-howto-title">
        <h2 id="pack-howto-title">Publish in Telegram</h2>
        <ol className="plain-list">
          <li>Export the ZIP and unpack it. <code>pack.txt</code> lists every file with its emoji.</li>
          <li>Open the official <strong>@Stickers</strong> bot and send <code>{BOT_COMMAND[summary.kind || 'static']}</code>{summary.kind ? '' : ' (video stickers: /newvideo)'}.</li>
          <li>Send the pack title, then each file in order as a document and its emoji right after it.</li>
          <li>Send <code>/publish</code>, choose an icon or <code>/skip</code>, then the short name for the link.</li>
        </ol>
        <p className="muted small">This app never talks to Telegram; publishing stays in your hands.</p>
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${pack.title}”?`}
        confirmLabel="Delete pack"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          setConfirmDelete(false);
          if (await run(() => packActions.deletePack(pack.id))) onAfterDelete();
        }}
      >
        <p>The pack’s order and emoji are removed. The {plural(pack.items.length, 'sticker')} and their files stay in the library.</p>
      </ConfirmDialog>
    </section>
  );
}

export function PacksView({
  packState, stickersById, selectedPackId, onSelectPack, packActions, onOpenSticker, onGoToLibrary, bootstrapState
}) {
  const { packs, activePackId, loadError, loaded } = packState;
  const selected = packs.find((pack) => pack.id === selectedPackId)
    || packs.find((pack) => pack.id === activePackId)
    || packs[0]
    || null;

  return (
    <div className="page packs-page">
      <div className="page-heading">
        <h1>Packs</h1>
        <p className="muted">Put stickers in order, give each an emoji and export a ZIP for the official @Stickers bot.</p>
      </div>

      {loadError && (
        <p className="inline-alert tone-problem" role="alert">
          The packs file could not be read, so it was left untouched and packs are read-only. Restore it from an archive snapshot in Health.
        </p>
      )}

      {!loaded ? (
        <div className="state-panel" aria-busy="true"><p>{bootstrapState === 'error' ? 'Can’t connect to the local service.' : 'Loading packs…'}</p></div>
      ) : (
        <div className="packs-layout">
          <nav className="pack-list" aria-label="Packs">
            {packs.length > 0 && (
              <ul>
                {packs.map((pack) => {
                  const summary = summarizePack(pack, stickersById);
                  return (
                    <li key={pack.id}>
                      <a
                        href={`?view=packs&pack=${pack.id}`}
                        aria-current={selected?.id === pack.id ? 'page' : undefined}
                        onClick={(event) => { event.preventDefault(); onSelectPack(pack.id); }}
                      >
                        <span className="pack-list-title">{pack.title}</span>
                        <span className="muted small tabular">
                          {summary.count} · {summary.kind ? KIND_LABELS[summary.kind] : 'Empty'}
                          {pack.id === activePackId ? ' · Current' : ''}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
            <NewPackForm onCreate={async (title) => onSelectPack((await packActions.createPack(title)).id)} submitLabel="New pack" />
          </nav>

          {selected ? (
            <PackDetail
              key={selected.id}
              pack={selected}
              isActive={selected.id === activePackId}
              stickersById={stickersById}
              packActions={packActions}
              onOpenSticker={onOpenSticker}
              onGoToLibrary={onGoToLibrary}
              onAfterDelete={() => onSelectPack(null)}
            />
          ) : (
            <div className="state-panel">
              <h2>No packs yet</h2>
              <p>A pack is an ordered set of stickers with an emoji each. Create one, then add stickers from the library.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
