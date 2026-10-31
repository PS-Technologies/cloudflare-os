import { Link } from '@tanstack/react-router'
import { MagnifyingGlass, X } from '@phosphor-icons/react'
import { Tooltip, TooltipProvider } from '@cloudflare/kumo'
import UserMenu from '../UserMenu'
import PanelToggle, { PANEL_BUTTON } from './PanelToggle'
import { usePrincipleFrame } from './PrincipleFrame'
import { openCommandPalette } from './commandPaletteBus'

const PrincipleSidebarTitle = ({ siteName, collapsed, mobile, onToggleCollapsed }: {
  siteName: string
  collapsed: boolean
  mobile: boolean
  onToggleCollapsed: () => void
}) => {
  const frame = usePrincipleFrame()
  return (
      <div className="mb-2 flex h-10 shrink-0 items-center gap-0.5 pl-2.5">
        <Link to="/" aria-label={siteName} className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em] text-[var(--ink)]">
          {!collapsed && siteName}
        </Link>
        {!collapsed && (
          <>
            <TooltipProvider>
              <Tooltip side="bottom" content={<span className="flex items-center gap-2">Search <kbd className="rounded px-1 text-[11px] ring-1 ring-[var(--line-2)]">Ctrl K</kbd></span>} render={<button type="button" onClick={() => openCommandPalette()} aria-label="Search" className={PANEL_BUTTON} />}>
                <MagnifyingGlass size={16} />
              </Tooltip>
            </TooltipProvider>
            <UserMenu />
            {mobile ? (
              <button type="button" aria-label="Close menu" className={PANEL_BUTTON} onClick={() => onToggleCollapsed()}><X size={16} /></button>
            ) : (
              <PanelToggle docked={!frame.collapsed} onToggle={frame.toggleCollapsed} />
            )}
          </>
        )}
      </div>

  )
}

export default PrincipleSidebarTitle
