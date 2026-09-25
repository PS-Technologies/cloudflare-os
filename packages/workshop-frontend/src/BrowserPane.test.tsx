// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { BrowserPaneLink, BrowserPaneStatus, Overseer } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from './action-test-harness'
import BrowserPane, { DISCONNECTED_COPY, NO_BROWSER_COPY, WATCH_UNAVAILABLE_COPY } from './BrowserPane'

function fakeOverseer(status: BrowserPaneStatus, links: BrowserPaneLink[]) {
  const getBrowserPane = vi.fn(async () => status)
  const mintBrowserPaneLink = vi.fn(async () => {
    const next = links.shift()
    if (!next) throw new Error('no link scripted')
    return next
  })
  const overseer = { getBrowserPane, mintBrowserPaneLink } as unknown as RpcStub<Overseer>
  return { overseer, getBrowserPane, mintBrowserPaneLink, setStatus: (next: BrowserPaneStatus) => { status = next } }
}

const LINK_A: BrowserPaneLink = { ok: true, sessionId: 's1', url: 'https://dispatch.example/gatekeeper/browser/live/aaaa', expiresAt: '2026-01-01T00:00:00.000Z', access: 'watch' }
const LINK_B: BrowserPaneLink = { ok: true, sessionId: 's1', url: 'https://dispatch.example/gatekeeper/browser/live/bbbb', expiresAt: '2026-01-01T00:00:00.000Z', access: 'watch' }
const LINK_CONTROL: BrowserPaneLink = { ok: true, sessionId: 's1', url: 'https://dispatch.example/gatekeeper/browser/live/cccc', expiresAt: '2026-01-01T00:00:00.000Z', access: 'control' }

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('BrowserPane', () => {
  const view = makeTestRoot()
  afterEach(() => view.cleanup())

  function frame(): HTMLIFrameElement | null {
    return document.querySelector('[data-testid="browser-pane"] iframe')
  }
  function state(): string {
    return document.querySelector('[data-testid="browser-pane-state"]')?.textContent ?? ''
  }
  function access(): string {
    return document.querySelector('[data-testid="browser-pane-access"]')?.textContent ?? ''
  }
  function button(label: string): HTMLButtonElement {
    const found = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes(label))
    if (!found) throw new Error(`no button ${label}`)
    return found
  }

  it('says there is no browser yet and mints nothing', async () => {
    const server = fakeOverseer({ state: 'none' }, [])
    await view.render(<BrowserPane overseer={server.overseer} />)
    await settle()
    expect(document.body.textContent).toContain(NO_BROWSER_COPY)
    expect(state()).toBe('No browser yet')
    expect(server.mintBrowserPaneLink).not.toHaveBeenCalled()
    expect(frame()).toBeNull()
  })

  it('frames one link per session and keeps it across a status refresh', async () => {
    const server = fakeOverseer({ sessionId: 's1', state: 'idle' }, [LINK_A, LINK_B])
    await view.render(<BrowserPane overseer={server.overseer} />)
    await settle()
    expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(1)
    expect(frame()?.getAttribute('src')).toBe(LINK_A.url)
    expect(state()).toBe("Agent's browser")
    expect(access()).toBe('Watch only')

    // Same session, new status, same role: the frame is untouched.
    server.setStatus({ sessionId: 's1', state: 'waiting', instructions: 'Log in to Snowflake', youControl: false })
    await view.render(<BrowserPane overseer={server.overseer} />)
    await settle()
    expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(1)
    expect(frame()?.getAttribute('src')).toBe(LINK_A.url)
  })

  it('swaps a watching frame for a driving one when the agent hands the browser to this person, and back after Done', async () => {
    const server = fakeOverseer({ sessionId: 's1', state: 'idle' }, [LINK_A, LINK_CONTROL, LINK_B])
    await view.render(<BrowserPane overseer={server.overseer} refreshKey={0} />)
    await settle()
    expect(frame()?.getAttribute('src')).toBe(LINK_A.url)
    expect(access()).toBe('Watch only')

    server.setStatus({ sessionId: 's1', state: 'waiting', instructions: 'Sign in', youControl: true })
    await view.render(<BrowserPane overseer={server.overseer} refreshKey={1} />)
    await settle()
    expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(2)
    expect(frame()?.getAttribute('src')).toBe(LINK_CONTROL.url)
    expect(access()).toBe('You can drive')
    expect(state()).toBe('Waiting for you')

    server.setStatus({ sessionId: 's1', state: 'idle' })
    await view.render(<BrowserPane overseer={server.overseer} refreshKey={2} />)
    await settle()
    expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(3)
    expect(frame()?.getAttribute('src')).toBe(LINK_B.url)
    expect(access()).toBe('Watch only')
  })

  it('says when watch-only links are not set up, asks once, and offers no tab to open', async () => {
    const server = fakeOverseer({ sessionId: 's1', state: 'idle' }, [{ ok: false, reason: 'watch-unavailable' }])
    await view.render(<BrowserPane overseer={server.overseer} refreshKey={0} />)
    await settle()
    expect(state()).toBe('Watch only')
    expect(document.body.textContent).toContain(WATCH_UNAVAILABLE_COPY)
    expect(frame()).toBeNull()
    expect(button('Open in new tab').disabled).toBe(true)
    await view.render(<BrowserPane overseer={server.overseer} refreshKey={1} />)
    await settle()
    expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(1)
  })

  it('shows what the agent asked for while a person drives, and who that is', async () => {
    const server = fakeOverseer(
      { sessionId: 's1', state: 'waiting', instructions: 'Log in to Snowflake', youControl: true }, [LINK_CONTROL])
    await view.render(<BrowserPane overseer={server.overseer} />)
    await settle()
    expect(state()).toBe('Waiting for you')
    expect(access()).toBe('You can drive')
    expect(document.body.textContent).toContain('Log in to Snowflake')

    view.cleanup()
    const other = fakeOverseer(
      { sessionId: 's1', state: 'waiting', instructions: 'Log in', youControl: false }, [LINK_A])
    await view.render(<BrowserPane overseer={other.overseer} />)
    await settle()
    expect(state()).toBe('A person is driving')
    expect(access()).toBe('Watch only')
  })

  it('"New link" mints again and reloads the frame with the new link', async () => {
    const server = fakeOverseer({ sessionId: 's1', state: 'idle' }, [LINK_A, LINK_B])
    await view.render(<BrowserPane overseer={server.overseer} />)
    await settle()
    await act(async () => { button('New link').click() })
    await settle()
    expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(2)
    expect(frame()?.getAttribute('src')).toBe(LINK_B.url)
  })

  it('"Open in new tab" mints a link for the tab and leaves the frame alone', async () => {
    const server = fakeOverseer({ sessionId: 's1', state: 'idle' }, [LINK_A, LINK_B])
    const tab = { location: { href: '' }, close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    await view.render(<BrowserPane overseer={server.overseer} />)
    await settle()
    await act(async () => { button('Open in new tab').click() })
    await settle()
    expect(open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(tab.location.href).toBe(LINK_B.url)
    expect(frame()?.getAttribute('src')).toBe(LINK_A.url)
    open.mockRestore()
  })

  it('reports a dead session instead of framing anything', async () => {
    const server = fakeOverseer({ sessionId: 's1', state: 'idle' }, [{ ok: false, reason: 'disconnected' }])
    await view.render(<BrowserPane overseer={server.overseer} />)
    await settle()
    expect(state()).toBe('Disconnected')
    expect(document.body.textContent).toContain(DISCONNECTED_COPY)
    expect(frame()).toBeNull()
    expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(1)
  })

  it('re-reads status when the editor says a turn ended, without minting again', async () => {
    const server = fakeOverseer({ sessionId: 's1', state: 'idle' }, [LINK_A])
    await view.render(<BrowserPane overseer={server.overseer} refreshKey={0} />)
    await settle()
    expect(server.getBrowserPane).toHaveBeenCalledTimes(1)
    server.setStatus({ sessionId: 's1', state: 'waiting', instructions: 'Sign in', youControl: false })
    await view.render(<BrowserPane overseer={server.overseer} refreshKey={1} />)
    await settle()
    expect(server.getBrowserPane).toHaveBeenCalledTimes(2)
    expect(state()).toBe('A person is driving')
    expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(1)
  })

  it('never puts a Live View credential in the page: the frame src is the link as minted', async () => {
    const server = fakeOverseer({ sessionId: 's1', state: 'idle' }, [LINK_A])
    await view.render(<BrowserPane overseer={server.overseer} />)
    await settle()
    expect(document.body.innerHTML).not.toContain('jwt=')
    expect(frame()?.getAttribute('src')).toBe(LINK_A.url)
    expect(frame()?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })
})
