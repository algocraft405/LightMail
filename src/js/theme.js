'use strict';

const THEMES = {
  light: {
    name: 'Light',
    bg: '#faf9f8', nav: '#f5f5f5', panel: '#ffffff', chrome: '#faf9f8',
    ink: '#1f1f1f', muted: '#4b4b4b', faint: '#6e6e6e',
    line: '#edebe9', lineStrong: '#d1d1d1', hover: '#f3f2f1', search: '#f3f2f1',
    accent: '#0f6cbd', accentHover: '#115ea3',
    accentSoft: '#deecf9', selected: '#cfe4fa',
    onAccent: '#ffffff', danger: '#c4314b',
  },
  dark: {
    name: 'Dark',
    bg: '#1b1a19', nav: '#201f1e', panel: '#252423', chrome: '#201f1e',
    ink: '#f5f5f4', muted: '#d2d0ce', faint: '#b4b2b0',
    line: '#3b3a39', lineStrong: '#484644', hover: '#323130', search: '#323130',
    accent: '#6cb8f0', accentHover: '#8cc8f5',
    accentSoft: '#163a5f', selected: '#0f3a5f',
    onAccent: '#0b1220', danger: '#f1707b',
  },
  midnight: {
    name: 'Midnight',
    bg: '#0f172a', nav: '#111827', panel: '#1e293b', chrome: '#0b1220',
    ink: '#f8fafc', muted: '#dbe4ee', faint: '#b6c4d4',
    line: '#334155', lineStrong: '#475569', hover: '#1e293b', search: '#1e293b',
    accent: '#7dd3fc', accentHover: '#bae6fd',
    accentSoft: '#1e3a5f', selected: '#164e63',
    onAccent: '#0b1220', danger: '#fb7185',
  },
  sand: {
    name: 'Sand',
    bg: '#f6efe4', nav: '#efe6d8', panel: '#fffaf3', chrome: '#f3e9dc',
    ink: '#2c2118', muted: '#5c4a3c', faint: '#7d6754',
    line: '#e6d8c6', lineStrong: '#d4c2ab', hover: '#f0e4d4', search: '#efe4d4',
    accent: '#0f6cbd', accentHover: '#115ea3',
    accentSoft: '#ead9c4', selected: '#e4d0b4',
    onAccent: '#ffffff', danger: '#c4314b',
  },
};

function currentTheme() {
  const theme = (state.settings && state.settings.ui && state.settings.ui.theme) || {};
  return {
    id: THEMES[theme.id] ? theme.id : (theme.id === 'custom' ? 'custom' : 'light'),
    color: String(theme.color || ''),
    image: String(theme.image || ''),
    stamp: Number(theme.stamp) || 0,
  };
}

function hexLuma(hex) {
  const clean = String(hex || '').replace('#', '');
  if (clean.length !== 6) return 200;
  const n = parseInt(clean, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function mixHex(hex, other, amount) {
  const parse = (value) => {
    const clean = String(value || '').replace('#', '');
    if (clean.length !== 6) return [250, 249, 248];
    const n = parseInt(clean, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = parse(hex);
  const b = parse(other);
  const t = Math.min(1, Math.max(0, amount));
  const to = (channel) => Math.round(a[channel] * (1 - t) + b[channel] * t);
  return `#${[to(0), to(1), to(2)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function customPalette(color) {
  const base = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#faf9f8';
  const dark = hexLuma(base) < 150;
  const ink = dark ? '#f8f8f7' : '#1f1f1f';
  const panelMix = dark ? '#ffffff' : '#000000';
  const panelAmt = dark ? 0.08 : 0.04;
  return {
    name: 'Custom',
    bg: base,
    nav: mixHex(base, panelMix, panelAmt + 0.04),
    panel: mixHex(base, '#ffffff', dark ? 0.1 : 0.72),
    chrome: mixHex(base, panelMix, panelAmt),
    ink,
    muted: mixHex(ink, base, dark ? 0.22 : 0.36),
    faint: mixHex(ink, base, dark ? 0.38 : 0.5),
    line: mixHex(base, dark ? '#ffffff' : '#000000', dark ? 0.14 : 0.1),
    lineStrong: mixHex(base, dark ? '#ffffff' : '#000000', dark ? 0.2 : 0.16),
    hover: mixHex(base, dark ? '#ffffff' : '#000000', dark ? 0.1 : 0.06),
    search: mixHex(base, dark ? '#ffffff' : '#000000', dark ? 0.12 : 0.05),
    accent: dark ? '#6cb8f0' : '#0f6cbd',
    accentHover: dark ? '#8cc8f5' : '#115ea3',
    accentSoft: dark ? '#163a5f' : '#deecf9',
    selected: dark ? '#0f3a5f' : '#cfe4fa',
    onAccent: dark ? '#0b1220' : '#ffffff',
    danger: dark ? '#f1707b' : '#c4314b',
  };
}

function themeColors(theme) {
  if (theme.id === 'custom') return customPalette(theme.color || THEMES.light.bg);
  return THEMES[theme.id] || THEMES.light;
}

let wallpaperUrl = '';
let wallpaperName = '';

function paintWallpaper(url) {
  const wall = document.getElementById('wallpaper');
  if (!wall) return;
  const on = Boolean(url);
  document.body.classList.toggle('has-wallpaper', on);
  wall.hidden = !on;
  wall.style.backgroundImage = on ? `url("${url}")` : '';
}

async function loadWallpaper(theme) {
  if (!theme.image) {
    wallpaperUrl = '';
    wallpaperName = '';
    paintWallpaper('');
    return;
  }
  if (wallpaperUrl && wallpaperName === theme.image) {
    paintWallpaper(wallpaperUrl);
    return;
  }
  try {
    const data = await call(() => api.themeImageUrl());
    wallpaperUrl = (data && data.dataUrl) || '';
    wallpaperName = theme.image;
  } catch {
    wallpaperUrl = '';
    wallpaperName = '';
  }
  paintWallpaper(wallpaperUrl);
}

function paintMailFrame(colors) {
  const frame = document.querySelector('#mail-body iframe.mail-frame');
  if (!frame) return;
  const doc = frame.contentDocument;
  if (!doc || !doc.documentElement) return;
  const dark = hexLuma(colors.bg) < 150;
  doc.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  const body = doc.body;
  if (!body) return;
  body.style.color = colors.ink;
  body.style.backgroundColor = colors.panel;
}

function contrastOn(hex) {
  return hexLuma(hex) < 150 ? '#f3f3f3' : '#1a1a1a';
}

function applyThemeColors() {
  const theme = currentTheme();
  const colors = themeColors(theme);
  const dark = hexLuma(colors.bg) < 150;
  const accent = colors.accent || '#0f6cbd';
  const panel = colors.panel;
  const selected = colors.selected;
  const unread = Math.abs(hexLuma(accent) - hexLuma(panel)) < 70 ? contrastOn(panel) : accent;
  const root = document.documentElement;
  root.style.colorScheme = dark ? 'dark' : 'light';
  root.style.setProperty('--bg', colors.bg);
  root.style.setProperty('--nav', colors.nav);
  root.style.setProperty('--panel', panel);
  root.style.setProperty('--chrome', colors.chrome);
  root.style.setProperty('--ink', colors.ink);
  root.style.setProperty('--muted', colors.muted);
  root.style.setProperty('--faint', colors.faint);
  root.style.setProperty('--line', colors.line);
  root.style.setProperty('--line-strong', colors.lineStrong);
  root.style.setProperty('--hover', colors.hover);
  root.style.setProperty('--search', colors.search);
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-hover', colors.accentHover || '#115ea3');
  root.style.setProperty('--accent-soft', colors.accentSoft);
  root.style.setProperty('--selected', selected);
  root.style.setProperty('--on-accent', colors.onAccent || '#ffffff');
  root.style.setProperty('--on-panel', contrastOn(panel));
  root.style.setProperty('--on-selected', contrastOn(selected));
  root.style.setProperty('--unread', unread);
  root.style.setProperty('--danger', colors.danger || '#c4314b');
  root.style.setProperty('--icon-filter', dark ? 'invert(1)' : 'none');
  document.body.classList.toggle('theme-dark', dark);
  document.body.style.color = colors.ink;
  document.body.style.backgroundColor = colors.bg;
  paintMailFrame(colors);
}

function applyTheme() {
  applyThemeColors();
  return loadWallpaper(currentTheme());
}

function rememberTheme(partial) {
  if (partial.dataUrl) {
    wallpaperUrl = partial.dataUrl;
    wallpaperName = partial.image || wallpaperName;
  }
  if (partial.image === '') {
    wallpaperUrl = '';
    wallpaperName = '';
  }
  const next = { ...currentTheme(), ...partial };
  delete next.dataUrl;
  if (!state.settings) state.settings = { ui: {} };
  if (!state.settings.ui) state.settings.ui = {};
  state.settings.ui.theme = next;
  applyThemeColors();
  paintWallpaper(wallpaperUrl);
  saveUi();
  if (next.image && !wallpaperUrl) loadWallpaper(next);
  return next;
}
