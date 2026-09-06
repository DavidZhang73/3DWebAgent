import { flavors } from '@catppuccin/palette';

export const THEMES = ['latte', 'frappe', 'macchiato', 'mocha'] as const;
export type ThemeName = (typeof THEMES)[number];
export { flavors };
export function parseTheme(value: string | null): ThemeName {
  return THEMES.includes(value as ThemeName) ? (value as ThemeName) : 'mocha';
}
export function savedTheme(): ThemeName {
  try {
    return parseTheme(localStorage.getItem('3dwebagent.theme'));
  } catch {
    return 'mocha';
  }
}
export function applyTheme(name: ThemeName) {
  const flavor = flavors[name],
    root = document.documentElement;
  for (const [key, color] of flavor.colorEntries) root.style.setProperty('--ctp-' + key, color.hex);
  root.style.colorScheme = flavor.dark ? 'dark' : 'light';
  root.dataset.theme = name;
  try {
    localStorage.setItem('3dwebagent.theme', name);
  } catch {
    /* Storage is optional. */
  }
}
