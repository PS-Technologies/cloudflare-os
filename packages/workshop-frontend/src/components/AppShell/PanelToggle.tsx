import { Tooltip, TooltipProvider } from '@cloudflare/kumo'
import { SidebarSimple } from '@phosphor-icons/react'

export const PANEL_BUTTON = 'flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] text-[var(--ink-3)] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-[var(--card-2)] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[var(--ink)]'

export default function PanelToggle({ docked, onToggle, id }: {
  docked: boolean
  onToggle: (instant?: boolean) => void
  id?: string
}) {
  return (
    <TooltipProvider>
      <Tooltip
        side="bottom"
        content={<span className="flex items-center gap-2">Toggle sidebar <kbd className="rounded px-1 text-[11px] ring-1 ring-[var(--line-2)]">Ctrl Shift S</kbd></span>}
        render={<button type="button" id={id} aria-label={docked ? 'Collapse sidebar' : 'Dock sidebar'} aria-expanded={docked} className={PANEL_BUTTON} onClick={(event) => onToggle(event.detail === 0)} />}
      >
        <SidebarSimple size={16} />
      </Tooltip>
    </TooltipProvider>
  )
}
