'use strict';

// The panel follows the DevTools theme ('default' or 'dark'). Chrome applies a
// DevTools theme change after DevTools reopens, so reading it once is enough.
// Without the DevTools API (a page preview) it follows the system setting.
(function applyDevtoolsTheme() {
  const panels = globalThis.chrome && chrome.devtools && chrome.devtools.panels;
  const dark = panels && typeof panels.themeName === 'string'
    ? panels.themeName === 'dark'
    : globalThis.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
