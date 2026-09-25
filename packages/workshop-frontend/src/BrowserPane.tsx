import { useCallback, useEffect, useState } from 'react'
import { ArrowSquareOut, ArrowsClockwise } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import type { BrowserPaneStatus, Overseer } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './components/WorkshopControls'

// The workspace's shared browser, framed in the right pane. The frame shows Cloudflare's Live View
// in tab mode (address bar, Done/Failed bar) through a link on this origin that redirects to it,
// so the Live View credential never enters this page. One frame per Browser Run session and
// access level: a status refresh never touches the frame; a new session, a change between
// watching and driving, "New link" or a disconnect swaps it. Only the person the agent handed the
// browser to gets a frame that can drive; everyone else watches (the gateway decides, from the
// signed-in session, never from anything this page sends).

interface BrowserPaneProps {
  overseer: RpcStub<Overseer>
  // Bumped by the editor when an agent turn ends in the open chat, so the chip and instructions
  // follow a handoff the agent just started without polling.
  refreshKey?: number
}

type Access = 'control' | 'watch'

type Frame = { sessionId: string; url: string; access: Access }

type Problem = 'disconnected' | 'unavailable' | 'watch-unavailable' | null

export const NO_BROWSER_COPY = 'The agent has not opened a browser in this workspace yet.'
export const DISCONNECTED_COPY =
  'The browser session has ended. Ask the agent to open a page again; any sign-in is gone.'
export const WATCH_UNAVAILABLE_COPY = 'Watch-only links are not set up for this deployment yet.'
export const SHARED_COPY = 'Members of this workspace can watch this browser; the person the agent hands it to can drive it.'

export function accessLabel(access: Access): string {
  return access === 'control' ? 'You can drive' : 'Watch only'
}

function formatEndsIn(endsAt: string): string | null {
  const ms = Date.parse(endsAt) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return null
  const minutes = Math.ceil(ms / 60_000)
  return minutes <= 1 ? 'less than a minute left' : `${minutes} min left`
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

  const refreshStatus = useCallback(async () => {
    try {
      const next = await overseer.getBrowserPane()
      setStatus(next)
      setProblem(current => (current === 'unavailable' ? null : current))
    } catch {
      setProblem('unavailable')
    }
  }, [overseer])

  // Mints a fresh link. Returns it for callers that open it elsewhere; the frame is replaced
  // only when `replaceFrame` is set, so "Open in new tab" never reloads what the person is doing.
  const mint = useCallback(async (replaceFrame: boolean) => {
    setBusy(true)
    try {
      const link = await overseer.mintBrowserPaneLink()
      if (!link.ok) {
        if (link.reason === 'disconnected' || link.reason === 'watch-unavailable') {
          setProblem(link.reason)
          setFrame(null)
        }
        return null
      }
      setProblem(null)
      if (replaceFrame) setFrame({ sessionId: link.sessionId, url: link.url, access: link.access })
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

  // A frame follows the session and the viewer's role: mint when a session first appears or
  // changes, and again when the person is handed the browser (a watch frame cannot drive) or
  // hands it back (the driving frame is swapped for a watching one), never on a plain status
  // refresh. A deployment that cannot mint watch-only links asks once and then shows why.
  const sessionId = status?.sessionId
  const wanted: Access = status?.state === 'waiting' && status.youControl ? 'control' : 'watch'
  useEffect(() => {
    if (!sessionId || problem === 'disconnected') return
    if (problem === 'watch-unavailable' && wanted === 'watch') return
    if (frame?.sessionId === sessionId && frame.access === wanted) return
    void mint(true)
  }, [sessionId, wanted, frame?.sessionId, frame?.access, problem, mint])

  const openInNewTab = useCallback(async () => {
    // Open the window first so the click, not the awaited mint, is what the browser sees.
    const tab = window.open('about:blank', '_blank')
    const link = await mint(false)
    if (!tab) return
    if (link) tab.location.href = link.url
    else tab.close()
  }, [mint])

  const newLink = useCallback(async () => {
    setProblem(null)
    await refreshStatus()
    await mint(true)
  }, [refreshStatus, mint])

  const hasSession = Boolean(sessionId) && problem !== 'disconnected' && problem !== 'watch-unavailable'
  const endsIn = status?.state === 'waiting' && status.endsAt ? formatEndsIn(status.endsAt) : null

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="browser-pane">
      <div className="flex flex-shrink-0 flex-col gap-1 border-b border-kumo-line px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className="rounded-full bg-kumo-tint px-2 py-0.5 text-[12px] font-medium text-kumo-default"
            data-testid="browser-pane-state"
          >
            {stateLabel(status, problem)}
          </span>
          {frame && (
            <span className="text-[12px] text-kumo-subtle" data-testid="browser-pane-access">
              {accessLabel(frame.access)}
            </span>
          )}
          {endsIn && <span className="text-[12px] text-kumo-subtle">{endsIn}</span>}
          <span className="flex-1" />
          <WorkshopButton
            onClick={() => void newLink()}
            disabled={busy}
            title="Mint a fresh link and reload the frame"
          >
            <ArrowsClockwise size={14} className="mr-1" />
            New link
          </WorkshopButton>
          <WorkshopButton
            onClick={() => void openInNewTab()}
            disabled={busy || !hasSession}
            title="Open this browser in a new tab"
          >
            <ArrowSquareOut size={14} className="mr-1" />
            Open in new tab
          </WorkshopButton>
        </div>
        {status?.state === 'waiting' && status.instructions && (
          <p className="text-[13px] text-kumo-default">{status.instructions}</p>
        )}
        <p className="text-[12px] text-kumo-subtle">{SHARED_COPY}</p>
      </div>
      <div className="relative min-h-0 flex-1 bg-kumo-base">
        {frame ? (
          // no-referrer: the short link's path is a credential for as long as it lives, and must
          // not reach the Live View origin in a Referer header.
          <iframe
            key={`${frame.sessionId}:${frame.access}`}
            src={frame.url}
            title="Browser"
            className="h-full w-full border-0"
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
          />
        ) : (
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
    </div>
  )
}
