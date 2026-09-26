import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { EmojiPicker, NewPackForm } from './PackControls';
import { canAddToPack } from '../lib/packModel';
import { getStickerState, toSafeErrorMessage } from '../lib/stickerModel';

/**
 * Inspector block for the current pack: picking an emoji adds the sticker to
 * the pack; once in, the emoji can be changed or the sticker removed.
 */
export function PackInspectorSection({ sticker, activePack, packs, stickersById, packActions, onOpenPacks }) {
  const [error, setError] = useState('');
  const item = activePack?.items.find((entry) => entry.stickerId === sticker.id) || null;
  const position = item ? activePack.items.indexOf(item) + 1 : 0;
  const otherPacks = packs.filter((pack) => pack.id !== activePack?.id && pack.items.some((entry) => entry.stickerId === sticker.id));
  const addCheck = activePack && !item ? canAddToPack(activePack, sticker, stickersById) : null;
  const packLink = (
    <a href="?view=packs" onClick={(event) => { event.preventDefault(); onOpenPacks(activePack?.id); }}>
      {activePack?.title}
    </a>
  );

  const run = async (task) => {
    setError('');
    try {
      await task();
    } catch (actionError) {
      setError(toSafeErrorMessage(actionError.message));
    }
  };

  return (
    <section className="inspector-section" aria-label="Pack">
      <h3>Pack</h3>
      {!activePack ? (
        <>
          <p className="muted small">Collect stickers into a pack, give each an emoji and export it for the @Stickers bot.</p>
          <NewPackForm onCreate={packActions.createPack} />
        </>
      ) : item ? (
        <>
          <p className="small">In {packLink} · <span className="tabular">#{position} of {activePack.items.length}</span></p>
          {getStickerState(sticker) !== 'ready' && (
            <p className="muted small">Convert this sticker before exporting the pack.</p>
          )}
          <EmojiPicker
            key={item.emoji.join('')}
            value={item.emoji}
            label="Emoji for this sticker"
            onChange={(emoji) => packActions.setEmoji(activePack.id, sticker.id, emoji)}
          />
          <button type="button" className="btn btn-ghost pack-remove" onClick={() => run(() => packActions.removeSticker(activePack.id, sticker.id))}>
            <X size={16} aria-hidden="true" /> Remove from pack
          </button>
        </>
      ) : addCheck.ok ? (
        <>
          <p className="small">Pick an emoji to add it to {packLink}.</p>
          <EmojiPicker
            value={[]}
            label="Emoji"
            onChange={(emoji) => packActions.addStickers(activePack.id, [sticker.id], emoji)}
          />
          <button type="button" className="link-btn" onClick={() => run(() => packActions.addStickers(activePack.id, [sticker.id]))}>
            <Plus size={14} aria-hidden="true" /> Add without emoji for now
          </button>
        </>
      ) : (
        <p className="muted small">Current pack {packLink}: {addCheck.reason}</p>
      )}
      {otherPacks.length > 0 && (
        <p className="muted small">Also in: {otherPacks.map((pack) => pack.title).join(', ')}</p>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
    </section>
  );
}
