import { useCallback, useEffect, useRef, useState } from 'react';
import { buildViewSearch, parseViewState } from '../lib/stickerModel';

const DETAIL_MARKER = 'sticker-detail';

/**
 * Keeps view, filters, page and the selected sticker in the query string so
 * Back/Forward and reloads restore the same catalogue position.
 */
export function useViewState() {
  const [viewState, setViewState] = useState(() => parseViewState(window.location.search));
  const stateRef = useRef(viewState);

  useEffect(() => {
    const onPopState = () => {
      const next = parseViewState(window.location.search);
      stateRef.current = next;
      setViewState(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const updateView = useCallback((patch, { push = false, marker = null } = {}) => {
    const next = { ...stateRef.current, ...patch };
    const search = buildViewSearch(next);
    const url = `${window.location.pathname}${search ? `?${search}` : ''}`;
    if (url !== `${window.location.pathname}${window.location.search}`) {
      window.history[push ? 'pushState' : 'replaceState'](marker, '', url);
    }
    stateRef.current = next;
    setViewState(next);
  }, []);

  const openSticker = useCallback((id) => {
    const alreadyOpen = Boolean(stateRef.current.id);
    updateView({ id }, alreadyOpen
      ? { marker: window.history.state }
      : { push: true, marker: DETAIL_MARKER });
  }, [updateView]);

  // Closing a detail opened from the list steps back in history, so the
  // browser Back button and the close button behave the same way.
  const closeSticker = useCallback(() => {
    if (window.history.state === DETAIL_MARKER) {
      window.history.back();
      return;
    }
    updateView({ id: null });
  }, [updateView]);

  return { viewState, updateView, openSticker, closeSticker };
}
