import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowSquareOut, ArrowsClockwise, ArrowsInSimple, ArrowsOutSimple, Code } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import type { BrowserPaneLinkRequest, BrowserPaneStatus, BrowserPaneTab, Overseer } from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'

// The workspace's shared browser, framed in the right pane. The frame shows Cloudflare's Live View
// in tab mode (address bar, Done/Failed bar) through a link on this origin that redirects to it,
// so the Live View credential never enters this page. One frame per Browser Run session, access
// level, tab and view: a status refresh never touches the frame; a new session, a change between
// watching and driving, another tab, the developer view, "New link" or a disconnect swaps it.
// Only the person the agent handed the browser to gets a frame that can drive; everyone else
// watches (the gateway decides, from the signed-in session, never from anything this page sends).
//
// When the browser has more than one page tab (a sign-in popup, a page the agent opened in a new
// tab) a strip lists them. The frame follows the gateway's default tab, the handoff's page while a
// person drives and otherwise the newest, until the person picks one. Full screen lays this pane
// over the whole workspace. Developer view (Cloudflare's developer tools for the tab: console,
// network) can run JavaScript in the page, so it is offered only while this person's frame can
// drive, and the gateway gives it to nobody else. When their turn ends, a frame that could drive
// leaves the page at once (closing its connection) and a watching one replaces it; a
// developer-tools link never goes to a new tab, where the pane could not close it.

interface BrowserPaneProps {
  overseer: RpcStub<Overseer>
  // Bumped by the editor when an agent turn ends in the open chat, so the chip and instructions
  // follow a handoff the agent just started without waiting for the next refresh.
  refreshKey?: number
}

type Access = 'control' | 'watch'

type Frame = { sessionId: string; url: string; access: Access; tabId?: string; developer: boolean }

type Problem = 'disconnected' | 'unavailable' | 'watch-unavailable' | null

// What this person chose, for one session and role (see `scope` below).
type Choice = { scope: string; tabId?: string; developer: boolean }

// Tabs open and close while no agent turn ends (a sign-in popup during a handoff), so the status is
// re-read this often while someone is looking at the pane: the page visible and the window focused.
// The gateway lists tabs over Browser Run's HTTP API, never through the browser connection the
// agent uses, and Browser Run may count a listing as activity that keeps an idle browser alive, so a
// pane left open in a background window must not.
export const STATUS_REFRESH_MS = 15_000

export const NO_BROWSER_COPY = 'The agent has not opened a browser in this workspace yet.'
export const DISCONNECTED_COPY =
  'The browser session has ended. Ask the agent to open a page again; any sign-in is gone.'
export const WATCH_UNAVAILABLE_COPY = 'Watch-only links are not set up for this deployment yet.'
export const SHARED_COPY = 'Members of this workspace can watch this browser; the person the agent hands it to can drive it.'
export const BEHIND_COPY = "If this looks blank, the tab is behind another one; the agent's browser only draws the tab in front."
// Cloudflare's Done and Failed buttons are on the page view; the developer tools cover them.
export const DEVELOPER_DONE_COPY = 'Switch back to the page view to press Done.'
// A tab switch takes a new link; while a person drives it can take several seconds.
export const SWITCHING_AFTER_MS = 1_000

export function switchingCopy(label: string): string {
  return `Opening ${label}… This can take a few seconds while a person is driving.`
}

export function doneElsewhereCopy(label: string): string {
  return `Done is on the ${label} tab.`
}

export function accessLabel(access: Access): string {
  return access === 'control' ? 'You can drive' : 'Watch only'
}

export function tabLabel(tab: BrowserPaneTab): string {
  return tab.title || tab.host || 'New tab'
}

function formatEndsIn(endsAt: string): string | null {
  const ms = Date.parse(endsAt) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return null
  const minutes = Math.ceil(ms / 60_000)
  return minutes <= 1 ? 'less than a minute left' : `${minutes} min left`
}

function linkRequest(tabId: string | undefined, developer: boolean): BrowserPaneLinkRequest {
  return { ...(tabId ? { tabId } : {}), ...(developer ? { developer: true } : {}) }
}

export function stateLabel(status: BrowserPaneStatus | null, problem: Problem): string {
  if (problem === 'disconnected') return 'Disconnected'
  if (problem === 'unavailable') return 'Unavailable'
  if (problem === 'watch-unavailable') return 'Watch only'
  if (!status || status.state === 'none') return 'No browser yet'
  if (status.state === 'waiting') return status.youControl ? 'Waiting for you' : 'A person is driving'
  return "Agent's browser"
}

export default function BrowserPane({ overseer, refreshKey = 0 }: BrowserPaneProps) {
  const [status, setStatus] = useState<BrowserPaneStatus | null>(null)
  const [frame, setFrame] = useState<Frame | null>(null)
  const [problem, setProblem] = useState<Problem>(null)
  const [busy, setBusy] = useState(false)
  const [choice, setChoice] = useState<Choice>({ scope: '', developer: false })
  const [fullscreen, setFullscreen] = useState(false)
  const [showFullscreenHint, setShowFullscreenHint] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const focusBeforeFullscreenRef = useRef<HTMLElement | null>(null)

  const refreshStatus = useCallback(async () => {
    try {
      const next = await overseer.getBrowserPane({ tabs: true })
      setStatus(next)
      setProblem(current => (current === 'unavailable' ? null : current))
    } catch {
      setProblem('unavailable')
    }
  }, [overseer])

  // Mints a fresh link. Returns it for callers that open it elsewhere; the frame is replaced
  // only when `replaceFrame` is set, so "Open in new tab" never reloads what the person is doing.
  const mint = useCallback(async (replaceFrame: boolean, request: BrowserPaneLinkRequest) => {
    setBusy(true)
    try {
      const link = await overseer.mintBrowserPaneLink(request)
      if (!link.ok) {
        if (link.reason === 'disconnected' || link.reason === 'watch-unavailable') {
          setProblem(link.reason)
          setFrame(null)
        } else if (link.reason === 'unavailable') {
          // Browser Run is busy for now: keep what is on screen and try again at the next refresh.
          setProblem('unavailable')
        }
        return null
      }
      setProblem(null)
      // The tab asked for has closed and the gateway framed the default: follow the default.
      if (request.tabId && link.tabId !== request.tabId) {
        setChoice(current => ({ ...current, tabId: undefined }))
      }
      if (replaceFrame) {
        setFrame({
          sessionId: link.sessionId, url: link.url, access: link.access, tabId: link.tabId,
          developer: link.developer === true,
        })
      }
      // The gatekeeper brought the driver's tab forward for this link: it is in front now.
      if (link.front && link.tabId) {
        const inFront = link.tabId
        setStatus(current => (current ? { ...current, frontTabId: inFront } : current))
      }
      return link
    } catch {
      setProblem('unavailable')
      return null
    } finally {
      setBusy(false)
    }
  }, [overseer])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus, refreshKey])

  const sessionId = status?.sessionId
  useEffect(() => {
    if (!sessionId) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void refreshStatus()
    }, STATUS_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [sessionId, refreshStatus])

  // The person's turn ends when the handoff does. Ask again then, looking or not, so a frame that
  // could drive (developer tools included) does not stay open past it.
  const turnEndsAt = status?.state === 'waiting' && status.youControl ? status.endsAt : undefined
  useEffect(() => {
    if (!turnEndsAt) return
    const ms = Date.parse(turnEndsAt) - Date.now()
    if (!Number.isFinite(ms)) return
    const timer = window.setTimeout(() => void refreshStatus(), Math.max(0, ms) + 1000)
    return () => window.clearTimeout(timer)
  }, [turnEndsAt, refreshStatus])

  // A frame follows the session and the viewer's role: mint when a session first appears or
  // changes, and again when the person is handed the browser (a watch frame cannot drive) or
  // hands it back (the driving frame is swapped for a watching one), never on a plain status
  // refresh. A deployment that cannot mint watch-only links asks once and then shows why.
  const wanted: Access = status?.state === 'waiting' && status.youControl ? 'control' : 'watch'
  // The person's tab and view hold for one session and role: being handed the browser, or handing
  // it back, starts over on the default tab (then the handoff's page) and the page view.
  const scope = `${sessionId ?? ''}:${wanted}`
  const chosen: Choice = choice.scope === scope ? choice : { scope, developer: false }
  const tabs = status?.tabs ?? []
  const tabId = chosen.tabId !== undefined && tabs.some(tab => tab.id === chosen.tabId)
    ? chosen.tabId
    : status?.tabId
  const developer = chosen.developer && wanted === 'control'
  const front = status?.frontTabId

  // "Disconnected" is about one session: a new one (the agent's next call launched a browser) is
  // tried afresh.
  useEffect(() => {
    setProblem(current => (current === 'disconnected' ? null : current))
  }, [sessionId])
  useEffect(() => {
    if (!sessionId || problem === 'disconnected') return
    if (problem === 'watch-unavailable' && wanted === 'watch') return
    if (frame?.sessionId === sessionId && frame.access === wanted && frame.developer === developer
        && (tabId === undefined || frame.tabId === tabId)) return
    void mint(true, linkRequest(tabId, developer))
  }, [sessionId, wanted, tabId, developer, frame?.sessionId, frame?.access, frame?.tabId, frame?.developer, problem, mint])

  const openInNewTab = useCallback(async () => {
    // Open the window first so the click, not the awaited mint, is what the browser sees.
    const tab = window.open('about:blank', '_blank')
    // Never the developer tools: a tab elsewhere is one the pane cannot close when the turn ends.
    const link = await mint(false, linkRequest(frame?.tabId ?? tabId, false))
    if (!tab) return
    if (link) tab.location.href = link.url
    else tab.close()
  }, [mint, frame?.tabId, tabId])

  const newLink = useCallback(async () => {
    setProblem(null)
    await refreshStatus()
    await mint(true, linkRequest(tabId, developer))
  }, [refreshStatus, mint, tabId, developer])

  // Full screen, on the gadget preview's pattern (GadgetEditor): the pane covers the workspace,
  // focus moves into it and back to where it was, and a hint says how to leave. Esc works while
  // focus is on this page; inside the frame keys belong to the remote page, whose origin cannot
  // forward them, so the same button stays on screen to leave.
  const enterFullscreen = useCallback(() => {
    focusBeforeFullscreenRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setFullscreen(true)
    setShowFullscreenHint(true)
  }, [])
  const exitFullscreen = useCallback(() => setFullscreen(false), [])
  useEffect(() => {
    if (!showFullscreenHint) return
    const timeout = setTimeout(() => setShowFullscreenHint(false), 4000)
    return () => clearTimeout(timeout)
  }, [showFullscreenHint])
  useEffect(() => {
    if (fullscreen) {
      rootRef.current?.focus()
    } else if (focusBeforeFullscreenRef.current) {
      if (focusBeforeFullscreenRef.current.isConnected) focusBeforeFullscreenRef.current.focus()
      focusBeforeFullscreenRef.current = null
    }
  }, [fullscreen])
  useEffect(() => {
    if (!fullscreen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitFullscreen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullscreen, exitFullscreen])

  const hasSession = Boolean(sessionId) && problem !== 'disconnected' && problem !== 'watch-unavailable'
  // A frame that could drive is shown only while this person may drive. The moment the status says
  // their turn is over it leaves the page, closing its connection, whether or not a watching frame
  // can be minted to replace it.
  const shown = frame && (frame.access === 'watch' || wanted === 'control') ? frame : null
  // The strip marks the tab on screen once its link is in: a tab Browser Run did not open is never
  // shown as the one framed.
  const shownTabId = shown?.tabId !== undefined && tabs.some(tab => tab.id === shown.tabId) ? shown.tabId : tabId
  // Chrome paints only the tab in front, and Live View may show any other as a blank box. The pane
  // knows which tab is in front only as well as the gatekeeper does, so this is advice: the tab is
  // always framed, and the note says why it might look blank. The person driving can bring it
  // forward; a watcher cannot change the agent's browser. Not while a link is being minted: a
  // watcher following the front tab still has the old frame up then, and would see the note flicker.
  const mayBeBehind = !busy && shown !== null && shownTabId !== undefined && front !== undefined && shownTabId !== front
    && tabs.some(tab => tab.id === front)
  const endsIn = status?.state === 'waiting' && status.endsAt ? formatEndsIn(status.endsAt) : null
  const canDrive = wanted === 'control' && shown?.access === 'control'
  // Cloudflare's Done panel is on one tab only: the one the handoff is bound to. The person driving
  // opens there; if they move to another tab (a sign-in popup), the pane says where Done is.
  const doneTab = canDrive && status?.handoffTabId !== undefined
    ? tabs.find(tab => tab.id === status.handoffTabId)
    : undefined
  const doneElsewhere = doneTab !== undefined && shownTabId !== doneTab.id
  // A link for another tab is on its way: say so if it takes a while, rather than leave the old tab
  // up with no sign anything is happening.
  const switchingTo = busy && tabId !== undefined && shown !== null && shown.tabId !== tabId
    ? tabs.find(tab => tab.id === tabId)
    : undefined
  const switchingTabId = switchingTo?.id
  const [slowSwitch, setSlowSwitch] = useState<string | undefined>(undefined)
  useEffect(() => {
    setSlowSwitch(undefined)
    if (!switchingTabId) return
    const timer = window.setTimeout(() => setSlowSwitch(switchingTabId), SWITCHING_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [switchingTabId])

  return (
    <div
      ref={rootRef}
      tabIndex={fullscreen ? -1 : undefined}
      role={fullscreen ? 'dialog' : undefined}
      aria-modal={fullscreen ? true : undefined}
      aria-label={fullscreen ? 'Browser full screen' : undefined}
      className={fullscreen
        ? 'visual-viewport-fixed z-20 flex flex-col bg-kumo-base outline-none'
        : 'flex h-full min-h-0 flex-col'}
      data-testid="browser-pane"
    >
      <div className="flex flex-shrink-0 flex-col gap-1 border-b border-kumo-line px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-full bg-kumo-tint px-2 py-0.5 text-[12px] font-medium text-kumo-default"
            data-testid="browser-pane-state"
          >
            {stateLabel(status, problem)}
          </span>
          {shown && (
            <span className="text-[12px] text-kumo-subtle" data-testid="browser-pane-access">
              {accessLabel(shown.access)}
            </span>
          )}
          {endsIn && <span className="text-[12px] text-kumo-subtle">{endsIn}</span>}
          <span className="flex-1" />
          {canDrive && (
            <WorkshopButton
              onClick={() => setChoice({ ...chosen, developer: !chosen.developer })}
              disabled={busy}
              aria-pressed={developer}
              title="Show this tab's console and network. Only the person driving can open them."
            >
              <Code size={14} className="mr-1" />
              Developer view
            </WorkshopButton>
          )}
          <WorkshopButton
            onClick={() => void newLink()}
            disabled={busy}
            title="Mint a fresh link and reload the frame"
          >
            <ArrowsClockwise size={14} className="mr-1" />
            New link
          </WorkshopButton>
          {!developer && !shown?.developer && (
            <WorkshopButton
              onClick={() => void openInNewTab()}
              disabled={busy || !hasSession}
              title="Open this browser in a new tab"
            >
              <ArrowSquareOut size={14} className="mr-1" />
              Open in new tab
            </WorkshopButton>
          )}
          <WorkshopIconButton
            aria-label={fullscreen ? 'Exit full screen' : 'Enter full screen'}
            title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
            onClick={fullscreen ? exitFullscreen : enterFullscreen}
            disabled={!fullscreen && !shown}
          >
            {fullscreen ? <ArrowsInSimple size={17} /> : <ArrowsOutSimple size={17} />}
          </WorkshopIconButton>
        </div>
        {tabs.length > 1 && (
          <div
            role="group"
            aria-label="Browser tabs"
            className="flex min-w-0 items-center gap-1 overflow-x-auto"
            data-testid="browser-pane-tabs"
          >
            {tabs.map(tab => (
              <button
                key={tab.id}
                type="button"
                aria-pressed={tab.id === shownTabId}
                title={tab.host || tabLabel(tab)}
                onClick={() => setChoice({ ...chosen, tabId: tab.id })}
                className={`flex min-w-0 max-w-[180px] flex-shrink-0 cursor-pointer items-center rounded-md px-2 py-1 text-[12.5px] font-medium tracking-[-0.15px] transition-colors duration-150 ${
                  tab.id === shownTabId ? 'bg-kumo-tint text-kumo-default' : 'text-kumo-subtle hover:text-kumo-default'
                }`}
              >
                <span className="truncate">{tabLabel(tab)}</span>
              </button>
            ))}
          </div>
        )}
        {status?.state === 'waiting' && status.instructions && (
          <p className="text-[13px] text-kumo-default">{status.instructions}</p>
        )}
        {canDrive && shown?.developer && (
          <p className="text-[13px] font-medium text-kumo-default" data-testid="browser-pane-developer-done">
            {DEVELOPER_DONE_COPY}
          </p>
        )}
        {doneElsewhere && (
          <div className="flex flex-wrap items-center gap-2" data-testid="browser-pane-done-elsewhere">
            <p className="text-[13px] font-medium text-kumo-default">{doneElsewhereCopy(tabLabel(doneTab))}</p>
            <WorkshopButton
              onClick={() => setChoice({ ...chosen, tabId: doneTab.id })}
              disabled={busy}
              title="Go to the tab with the Done and Failed buttons"
            >
              Go to Done
            </WorkshopButton>
          </div>
        )}
        {switchingTo && slowSwitch === switchingTo.id && (
          <p role="status" aria-live="polite" className="text-[13px] text-kumo-default" data-testid="browser-pane-switching">
            {switchingCopy(tabLabel(switchingTo))}
          </p>
        )}
        {mayBeBehind && (
          <div className="flex flex-wrap items-center gap-2" data-testid="browser-pane-behind">
            <p className="text-[13px] text-kumo-default">{BEHIND_COPY}</p>
            {canDrive && (
              <WorkshopButton
                onClick={() => void mint(true, linkRequest(shownTabId, developer))}
                disabled={busy}
                title="Bring this tab in front of the others, so the browser draws it"
              >
                Bring this tab to the front
              </WorkshopButton>
            )}
          </div>
        )}
        <p className="text-[12px] text-kumo-subtle">{SHARED_COPY}</p>
      </div>
      <div className="relative min-h-0 flex-1 bg-kumo-base">
        {shown && (
          // no-referrer: the short link's path is a credential for as long as it lives, and must
          // not reach the Live View origin in a Referer header.
          <iframe
            key={`${shown.sessionId}:${shown.access}:${shown.tabId ?? ''}:${shown.developer}`}
            src={shown.url}
            title="Browser"
            className="h-full w-full border-0"
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
          />
        )}
        {!shown && (
          <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-kumo-subtle">
            {problem === 'disconnected'
              ? DISCONNECTED_COPY
              : problem === 'watch-unavailable'
                ? WATCH_UNAVAILABLE_COPY
                : problem === 'unavailable'
                  ? 'The browser pane could not reach the workspace. Try again in a moment.'
                  : hasSession
                    ? 'Opening the browser…'
                    : NO_BROWSER_COPY}
          </div>
        )}
      </div>
      {fullscreen && showFullscreenHint && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 transform"
        >
          <div className="rounded-full border border-kumo-line bg-kumo-base/90 px-4 py-1.5 text-[13px] leading-[18px] text-kumo-default shadow-md backdrop-blur-sm">
            Press <kbd className="rounded border border-kumo-line bg-kumo-elevated px-1.5 py-0.5 text-[11px] font-medium">Esc</kbd> to exit full screen
          </div>
        </div>
      )}
    </div>
  )
}
