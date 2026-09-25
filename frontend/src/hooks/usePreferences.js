import { useCallback, useState } from 'react';

const STORAGE_KEY = 'sticker-workspace:prefs';
const VERSION = 1;
const DEFAULTS = { previewBackground: 'neutral', density: 'comfortable' };
const ALLOWED = {
  previewBackground: ['neutral', 'checker', 'chat-light', 'chat-dark'],
  density: ['comfortable', 'dense']
};

const readPreferences = () => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (!stored || stored.version !== VERSION) return DEFAULTS;
    return Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [
      key,
      ALLOWED[key].includes(stored[key]) ? stored[key] : fallback
    ]));
  } catch {
    return DEFAULTS;
  }
};

/** Per-viewer display preferences; storage failures fall back to defaults. */
export function usePreferences() {
  const [preferences, setPreferences] = useState(readPreferences);

  const setPreference = useCallback((key, value) => {
    if (!ALLOWED[key]?.includes(value)) return;
    setPreferences((previous) => {
      const next = { ...previous, [key]: value };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, version: VERSION }));
      } catch {
        // Private windows or blocked storage: keep the in-memory value only.
      }
      return next;
    });
  }, []);

  return { preferences, setPreference };
}
