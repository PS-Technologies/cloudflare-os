import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useReducedMotion } from 'motion/react'
import PanelToggle from './PanelToggle'

export { default as PrincipleRail } from '../PrincipleRail'

const PEEK_INTENT_MS = 120
const PEEK_GRACE_MS = 250
type Motion = 'dock' | 'peek-in' | 'peek-out' | 'instant'
type FrameState = {
  collapsed: boolean
  peeking: boolean
  motion: Motion
  reducedMotion: boolean | null
  panelRef: RefObject<HTMLDivElement | null>
  toggleCollapsed: (instant?: boolean) => void
  startPeek: () => void
  leavePeek: () => void
  enterPanel: () => void
  leavePanel: () => void
}
const FrameContext = createContext<FrameState | null>(null)

/** Docking and peek behavior layered around the Workshop's controlled sidebar preference. */
export const PrincipleFrameProvider = ({ collapsed, onToggleCollapsed, children }: {
  collapsed: boolean
  onToggleCollapsed: () => void
  children: ReactNode
}) => {
  const [peeking, setPeeking] = useState(false)
  const [motion, setMotion] = useState<Motion>('dock')
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inPanel = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotion()
  const toggleCollapsed = useCallback((instant = false) => {
    clearTimeout(peekTimer.current)
    setMotion(instant ? 'instant' : 'dock')
    setPeeking(false)
    if (!collapsed && panelRef.current?.contains(document.activeElement)) {
      requestAnimationFrame(() => document.getElementById('panel-toggle-canvas')?.focus())
    }
    onToggleCollapsed()
  }, [collapsed, onToggleCollapsed])

  const stopPeek = useCallback((instant = false) => {
    clearTimeout(peekTimer.current)
    setMotion(instant ? 'instant' : 'peek-out')
    setPeeking(false)
    if (panelRef.current?.contains(document.activeElement)) document.getElementById('panel-toggle-canvas')?.focus()
  }, [])

  const startPeek = () => {
    clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(() => {
      setMotion('peek-in')
      setPeeking(true)
    }, PEEK_INTENT_MS)
  }
  const leavePeek = () => {
    clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(() => {
      if (!inPanel.current) stopPeek()
    }, PEEK_GRACE_MS)
  }

  useEffect(() => () => clearTimeout(peekTimer.current), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        toggleCollapsed(true)
      } else if (event.key === 'Escape' && peeking) {
        stopPeek(true)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [toggleCollapsed, peeking, stopPeek])

  return <FrameContext.Provider value={{
    collapsed, peeking, motion, reducedMotion, panelRef, toggleCollapsed, startPeek, leavePeek,
    enterPanel: () => { inPanel.current = true; clearTimeout(peekTimer.current) },
    leavePanel: () => { inPanel.current = false; if (collapsed) leavePeek() },
  }}>{children}</FrameContext.Provider>
}

/** Controls shared by the Principle panel title row and canvas toggle. */
export const usePrincipleFrame = () => {
  const frame = useContext(FrameContext)
  if (!frame) throw new Error('Principle frame controls require PrincipleFrameProvider')
  return frame
}

const PrincipleFrame = ({ children }: { children: ReactNode }) => {
  const { collapsed, peeking, motion, reducedMotion, panelRef, startPeek, leavePeek, enterPanel, leavePanel } = usePrincipleFrame()
  return (
    <>
      <div
        data-panel-spacer
        className="hidden h-full shrink-0 transition-[width] duration-200 ease-in-out md:block motion-reduce:transition-none"
        style={{ width: collapsed ? 0 : 248, transitionDuration: motion === 'instant' ? '0ms' : undefined }}
      />
      {collapsed && (
        <div data-testid="peek-edge" aria-hidden className="absolute top-[60px] bottom-0 left-[68px] z-30 hidden w-3 md:block" onPointerEnter={startPeek} onPointerLeave={leavePeek} />
      )}
      <div
        ref={panelRef}
        data-panel
        data-state={collapsed ? peeking ? 'peeking' : 'collapsed' : 'docked'}
        data-motion={motion}
        inert={collapsed && !peeking ? true : undefined}
        className="absolute top-0 left-[68px] z-[5] hidden h-full w-[248px] bg-[var(--sidebar)] md:block"
        style={{
          transform: reducedMotion ? undefined : collapsed && !peeking ? 'translateX(-100%)' : 'translateX(0)',
          opacity: reducedMotion && collapsed && !peeking ? 0 : 1,
          borderRight: `1px solid ${peeking ? 'var(--line)' : 'transparent'}`,
          boxShadow: peeking ? 'var(--shadow-2)' : undefined,
          transitionProperty: reducedMotion ? 'opacity' : 'transform, box-shadow, border-color',
          transitionDuration: motion === 'instant' ? '0ms' : reducedMotion || motion === 'peek-out' ? '150ms' : '200ms',
          transitionTimingFunction: motion === 'dock' ? 'ease-in-out' : 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
        onPointerEnter={enterPanel}
        onPointerLeave={leavePanel}
      >
        {children}
      </div>

    </>
  )
}

/** Restores docking from the canvas while the panel is off-canvas. */
export const PrincipleCanvasToggle = () => {
  const { collapsed, toggleCollapsed } = usePrincipleFrame()
  return collapsed ? <div className="hidden md:block"><PanelToggle id="panel-toggle-canvas" docked={false} onToggle={toggleCollapsed} /></div> : null
}

export default PrincipleFrame
