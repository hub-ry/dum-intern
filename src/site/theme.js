(() => {
  const root = document.documentElement;
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const storageKey = 'dum-intern-theme';
  let choice = null;

  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === 'light' || stored === 'dark') choice = stored;
  } catch {
    // Theme switching still works when browser storage is unavailable.
  }

  function applyTheme() {
    const theme = choice || (systemTheme.matches ? 'dark' : 'light');
    const dark = theme === 'dark';
    root.dataset.theme = theme;
    root.style.colorScheme = theme;

    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.append(meta);
    }
    meta.content = dark ? '#242320' : '#fffffc';

    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.textContent = dark ? 'Light' : 'Dark';
      button.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`);
      button.setAttribute('aria-pressed', String(dark));
    });
  }

  applyTheme();

  function bindButtons() {
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.addEventListener('click', () => {
        choice = root.dataset.theme === 'dark' ? 'light' : 'dark';
        try {
          localStorage.setItem(storageKey, choice);
        } catch {
          // Keep this page usable even when the choice cannot be saved.
        }
        applyTheme();
      });
      button.hidden = false;
    });
    applyTheme();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindButtons, { once: true });
  } else {
    bindButtons();
  }

  function followSystem() {
    if (choice === null) applyTheme();
  }

  if (systemTheme.addEventListener) {
    systemTheme.addEventListener('change', followSystem);
  } else {
    systemTheme.addListener(followSystem);
  }
})();
