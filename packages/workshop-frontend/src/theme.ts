// Runtime color theming.
//
// The base light/dark palettes are defined statically in styles.css via Tailwind `@theme` CSS
// variables and `[data-mode="dark"]` overrides. Theme mode is applied on <html> so Kumo's semantic
// tokens and native controls resolve consistently. We also let a deployment override the *accent*
// family at runtime by setting those CSS variables on :root from an admin-chosen seed color.
// Hover/lighter/selection shades are derived from the seed with CSS relative-color syntax
// (`oklch(from <seed> ...)`), so the admin only picks one color.
//
// Only the accent-related variables are overridden at runtime; backgrounds, lines, and neutral text
// follow the light/dark palettes selected by `data-mode` in styles.css. The shared applicator
// validates the seed before interpolating it into CSS values.

// Principle: the three themes @ps/brand draws (light, navy as `dark`, charcoal), from the
// generated files in principle/. The choice is the `ps-theme` cookie on principlesvc.app, which
// the home page writes too, so both open in the same theme. Nothing saved follows the system, with
// charcoal as the dark. Kumo knows only light and dark, so `data-mode` carries that half.

import { applyAccentColor as applyAccentColorToStyle } from '@gadgets/workshop-shared/theme'

export type ThemeMode = 'light' | 'dark' | 'charcoal' | 'system'
export type ResolvedThemeMode = 'light' | 'dark'
/** A theme @ps/brand draws, set as `data-theme` on <html>. */
export type Theme = Exclude<ThemeMode, 'system'>

export const THEMES: readonly Theme[] = ['light', 'dark', 'charcoal']

const THEME_COOKIE = 'ps-theme'
const PARENT_DOMAIN = 'principlesvc.app'
const YEAR_S = 365 * 24 * 60 * 60

function isTheme(value: unknown): value is Theme {
  return THEMES.includes(value as Theme)
}

export function getSystemThemeMode(): ResolvedThemeMode {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function readThemeMode(): ThemeMode {
  try {
    const saved = new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=([^;]*)`).exec(document.cookie)?.[1]
    return isTheme(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

/** The cookie that saves `mode`, shared with every principlesvc.app host; `system` clears it. */
export function themeCookie(
  mode: ThemeMode,
  { hostname, protocol }: Pick<Location, 'hostname' | 'protocol'>,
): string {
  const shared = hostname === PARENT_DOMAIN || hostname.endsWith(`.${PARENT_DOMAIN}`)
  return [
    `${THEME_COOKIE}=${mode === 'system' ? '' : mode}`,
    'Path=/',
    `Max-Age=${mode === 'system' ? 0 : YEAR_S}`,
    'SameSite=Lax',
    shared ? `Domain=${PARENT_DOMAIN}` : '',
    protocol === 'https:' ? 'Secure' : '',
  ].filter(Boolean).join('; ')
}

export function writeThemeMode(mode: ThemeMode): void {
  try {
    document.cookie = themeCookie(mode, window.location)
  } catch {
    // Ignore storage failures; the selected mode still applies for this session.
  }
}

/** The theme `mode` draws now: `system` is light or charcoal. */
export function resolveTheme(mode: ThemeMode): Theme {
  if (mode !== 'system') return mode
  return getSystemThemeMode() === 'dark' ? 'charcoal' : 'light'
}

export function resolveThemeMode(mode: ThemeMode): ResolvedThemeMode {
  return resolveTheme(mode) === 'light' ? 'light' : 'dark'
}

export function applyThemeMode(mode: ThemeMode): ResolvedThemeMode {
  const theme = resolveTheme(mode)
  const resolved = resolveThemeMode(theme)
  const root = document.documentElement

  root.setAttribute('data-theme', theme)
  root.setAttribute('data-mode', resolved)
  root.style.colorScheme = resolved

  return resolved
}

export function applyStoredThemeMode(): ResolvedThemeMode {
  return applyThemeMode(readThemeMode())
}

/** Apply the accent color to the document root. Pass "" / invalid to clear back to the base theme. */
export function applyAccentColor(color: string | null | undefined): void {
  applyAccentColorToStyle(document.documentElement.style, color)
}

/** The base/default accent, shown in the admin picker when no custom color is set. */
export const DEFAULT_ACCENT_COLOR = '#ff4801'
