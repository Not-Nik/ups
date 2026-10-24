// Pre-paint theme: runs blocking in <head>, before any stylesheet, so a light-theme
// user never sees the dark default. common.js re-applies the same thing later.
{
    const t = localStorage.getItem('ups_theme');
    document.documentElement.dataset.bsTheme = t === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : (t || 'dark');
}
