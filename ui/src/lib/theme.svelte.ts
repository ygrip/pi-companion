export type ThemePreference = 'system' | 'light' | 'dark';

const KEY = 'pi-companion-theme';

class Theme {
  preference = $state<ThemePreference>('system');
  resolved = $state<'light' | 'dark'>('dark');
  private media: MediaQueryList | null = null;

  init() {
    if (this.media) return;
    this.media = matchMedia('(prefers-color-scheme: dark)');
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') this.preference = saved;
    this.media.addEventListener('change', () => this.apply());
    // Keep several open tabs in sync.
    addEventListener('storage', (event) => {
      if (event.key === KEY && event.newValue) {
        this.preference = event.newValue as ThemePreference;
        this.apply();
      }
    });
    this.apply();
  }

  set(preference: ThemePreference) {
    this.preference = preference;
    localStorage.setItem(KEY, preference);
    this.apply();
  }

  toggle() {
    this.set(this.resolved === 'dark' ? 'light' : 'dark');
  }

  private apply() {
    const dark = this.preference === 'dark' || (this.preference === 'system' && Boolean(this.media?.matches));
    this.resolved = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = this.resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0c0c0e' : '#f6f4ef');
  }
}

export const theme = new Theme();
