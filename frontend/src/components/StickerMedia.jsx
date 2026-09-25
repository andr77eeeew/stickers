import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { getOriginalPath } from '../lib/stickerModel';

/**
 * Original sticker image. Animated originals are shown as their first frame
 * when `still` is set or the viewer prefers reduced motion. A file that fails
 * to load shows a quiet placeholder instead of the browser's broken image.
 */
export function StickerMedia({ sticker, still = false, eager = false, className = '' }) {
  const reducedMotion = usePrefersReducedMotion();
  const useFrame = sticker.isAnimated && (still || reducedMotion);
  const src = useFrame ? `/api/stickers/${sticker.id}/frame/0` : getOriginalPath(sticker);
  const [failedSrc, setFailedSrc] = useState(null);

  if (failedSrc === src) {
    return (
      <span className={`sticker-media media-unavailable ${className}`} title="Image unavailable">
        <ImageOff size={22} aria-hidden="true" />
      </span>
    );
  }

  return (
    <img
      className={`sticker-media ${className}`}
      src={src}
      alt=""
      width={sticker.width || undefined}
      height={sticker.height || undefined}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      onError={() => setFailedSrc(src)}
    />
  );
}
