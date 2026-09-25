import { useSyncExternalStore } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const subscribeReducedMotion = (callback) => {
  const query = window.matchMedia?.(REDUCED_MOTION_QUERY);
  query?.addEventListener?.('change', callback);
  return () => query?.removeEventListener?.('change', callback);
};

export const usePrefersReducedMotion = () => useSyncExternalStore(
  subscribeReducedMotion,
  () => Boolean(window.matchMedia?.(REDUCED_MOTION_QUERY).matches),
  () => false
);
