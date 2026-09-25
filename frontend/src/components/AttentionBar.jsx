import { StickerMedia } from './StickerMedia';

export function AttentionBar({ summary, samples, onShow, convertibleCount, onConvert }) {
  if (!summary.total) return null;
  const parts = [
    summary.captured && `${summary.captured} not converted`,
    summary.failed && `${summary.failed} failed`,
    summary.outputMissing && `${summary.outputMissing} output missing`,
    summary.overLimit && `${summary.overLimit} over limit`
  ].filter(Boolean);

  return (
    <div className="attention-bar" role="status">
      <div className="attention-thumbs" aria-hidden="true">
        {samples.map((sticker) => (
          <span key={sticker.id} className="attention-thumb">
            <StickerMedia sticker={sticker} still />
          </span>
        ))}
      </div>
      <p>
        <strong>{summary.total} need action</strong>
        <span className="attention-parts"> · {parts.join(' · ')}</span>
      </p>
      <button type="button" className="btn" onClick={onShow}>Show</button>
      {convertibleCount > 0 && (
        <button type="button" className="btn btn-primary" onClick={onConvert}>Convert {convertibleCount}</button>
      )}
    </div>
  );
}
