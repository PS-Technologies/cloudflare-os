import {
  BriefcaseIcon,
  ChatsCircleIcon,
  HouseSimpleIcon,
  MoonIcon,
  MoonStarsIcon,
  RobotIcon,
  ScalesIcon,
  SquaresFourIcon,
  SunIcon,
  type Icon,
} from '@phosphor-icons/react'
import type { MouseEvent } from 'react'
import { RAIL_BADGE } from './rail-badge.ts'

// The rail every Principle app wears on its far left, Microsoft 365 style: the same places, in the same order, in the
// same tab, so moving between apps reads as moving within one. This file, rail.css and rail-badge.ts are copied byte
// for byte into Agent Dispatch, which cannot import this package, so they import nothing else and style nothing with
// an app's own classes.

/** A place the rail goes. */
export type RailPlace = 'home' | 'dispatch' | 'agents' | 'proposal' | 'contracts' | 'apps'

/** A theme the switch steps through: light, navy (`dark`) and charcoal. */
export type RailTheme = 'light' | 'dark' | 'charcoal'

/** Who is signed in, for the avatar at the rail's foot. */
export type RailPerson = { email: string; name?: string | null }

/** Where each place lives. */
export const RAIL_LINKS: Readonly<Record<RailPlace, string>> = {
  home: 'https://home.principlesvc.app',
  apps: 'https://home.principlesvc.app/apps',
  dispatch: 'https://dispatch.principlesvc.app',
  agents: 'https://agents.dispatch.principlesvc.app',
  proposal: 'https://proposals.principlesvc.app',
  contracts: 'https://contracts.principlesvc.app',
}

const THEME_ORDER: readonly RailTheme[] = ['light', 'dark', 'charcoal']
const THEME_NAME: Record<RailTheme, string> = { light: 'light', dark: 'navy', charcoal: 'charcoal' }
const THEME_ICON: Record<RailTheme, Icon> = { light: SunIcon, dark: MoonIcon, charcoal: MoonStarsIcon }

/** What the rail needs from the app wearing it. */
export type AppRailProps = {
  /** Where you are now; that place reads as selected. */
  current: RailPlace
  /** Who is signed in: undefined while the app still asks, null if it could not say. */
  me?: RailPerson | null
  theme: RailTheme
  onTheme: (next: RailTheme) => void
  /** Called on a plain click on a place. Return true to stay on the page instead; home switches Home and Apps in place. */
  onNavigate?: (place: RailPlace) => boolean
  /** `column` stands at the page's left edge; `drawer` rides in an app's slide-out drawer on a narrow screen. */
  variant?: 'column' | 'drawer'
  className?: string
}

/** The far-left rail: Principle's places, the theme switch and who you are. */
export function AppRail({ current, me, theme, onTheme, onNavigate, variant = 'column', className }: AppRailProps) {
  // A click with a modifier, or another button, opens a tab of the browser's choosing; only a plain click can stay.
  const follow = (place: RailPlace) => (e: MouseEvent<HTMLAnchorElement>) => {
    const plain = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
    if (plain && !e.defaultPrevented && onNavigate?.(place)) e.preventDefault()
  }
  const place = (at: RailPlace, label: string, icon: Icon, tone?: 'accent' | 'ok') => (
    <RailItem place={at} label={label} icon={icon} tone={tone} current={current === at} onClick={follow(at)} />
  )
  return (
    <nav aria-label="Principle" data-variant={variant} className={className ? `ps-rail ${className}` : 'ps-rail'}>
      <a href={RAIL_LINKS.home} aria-label="Principle home" className="ps-rail-badge ps-rail-press" onClick={follow('home')}>
        {/* The navy badge vanishes on a dark floor, so each mode gets the badge drawn for it. */}
        <img src={RAIL_BADGE.forLight} alt="" className="ps-rail-badge-light" />
        <img src={RAIL_BADGE.forDark} alt="" className="ps-rail-badge-dark" />
      </a>
      {place('home', 'Home', HouseSimpleIcon)}
      {place('dispatch', 'Dispatch', ChatsCircleIcon)}
      {place('agents', 'Agents', RobotIcon)}
      <span aria-hidden="true" className="ps-rail-rule" />
      {/* Studios carry their colour on a tile, so the rail reads at a glance. */}
      {place('proposal', 'Proposal', BriefcaseIcon, 'accent')}
      {place('contracts', 'Contracts', ScalesIcon, 'ok')}
      {place('apps', 'Apps', SquaresFourIcon)}
      <span className="ps-rail-fill" />
      <ThemeSwitch theme={theme} onTheme={onTheme} />
      <span title={me ? (me.name ?? me.email) : undefined} className="ps-rail-avatar">
        {me ? initials(me) : null}
      </span>
    </nav>
  )
}

type RailItemProps = { place: RailPlace; label: string; icon: Icon; tone?: 'accent' | 'ok'; current: boolean; onClick: (e: MouseEvent<HTMLAnchorElement>) => void }

function RailItem({ place, label, icon: IconCmp, tone, current, onClick }: RailItemProps) {
  return (
    <a href={RAIL_LINKS[place]} className="ps-rail-item ps-rail-press" aria-current={current ? 'page' : undefined} onClick={onClick}>
      <span className="ps-rail-icon">
        {tone ? (
          <span className="ps-rail-tile" data-tone={tone}>
            <IconCmp size={15} />
          </span>
        ) : (
          <IconCmp size={18} />
        )}
      </span>
      {label}
    </a>
  )
}

// One button that steps through light, navy and charcoal. It shows where you are; its tip says where it goes.
function ThemeSwitch({ theme, onTheme }: { theme: RailTheme; onTheme: (next: RailTheme) => void }) {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!
  const IconCmp = THEME_ICON[theme]
  return (
    <button
      type="button"
      aria-label={`Theme: ${THEME_NAME[theme]}. Switch to ${THEME_NAME[next]}`}
      data-tip={`Switch to ${THEME_NAME[next]}`}
      className="ps-rail-switch ps-rail-press"
      onClick={() => onTheme(next)}
    >
      <IconCmp size={18} />
    </button>
  )
}

function initials({ name, email }: RailPerson) {
  const words = name?.split(/\s+/).filter(Boolean) ?? []
  const letters = words.length > 1 ? words[0]![0]! + words.at(-1)![0]! : (words[0] ?? email)[0]!
  return letters.toUpperCase()
}
