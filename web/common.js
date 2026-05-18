const THEME_CYCLE = ['dark', 'light', 'system'];
const THEME_ICONS = { dark: '☾', light: '☀', system: '◑' };
let _systemThemeListener = null;

function applyTheme(theme) {
  if (_systemThemeListener) {
    window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', _systemThemeListener);
    _systemThemeListener = null;
  }
  if (theme === 'system') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    _systemThemeListener = () => { document.documentElement.dataset.bsTheme = mq.matches ? 'dark' : 'light'; };
    _systemThemeListener();
    mq.addEventListener('change', _systemThemeListener);
  } else {
    document.documentElement.dataset.bsTheme = theme;
  }
  document.getElementById('theme-toggle').textContent = THEME_ICONS[theme];
}

applyTheme(localStorage.getItem('ups_theme') ?? 'dark');
document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = localStorage.getItem('ups_theme') ?? 'dark';
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
  localStorage.setItem('ups_theme', next);
  applyTheme(next);
});
