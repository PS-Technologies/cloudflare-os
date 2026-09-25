// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { BrowserPaneLink, BrowserPaneStatus, BrowserPaneTab, Overseer } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from './action-test-harness'
import BrowserPane, { BEHIND_COPY, DEVELOPER_DONE_COPY, DISCONNECTED_COPY, NO_BROWSER_COPY, STATUS_REFRESH_MS, WATCH_UNAVAILABLE_COPY } from './BrowserPane'

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

  it('frames a new browser once the agent opens one after the last session died', async () => {
    const LINK_S2: BrowserPaneLink = { ...LINK_A, sessionId: 's2' }
    const server = fakeOverseer({ sessionId: 's1', state: 'idle' }, [{ ok: false, reason: 'disconnected' }, LINK_S2])
    await view.render(<BrowserPane overseer={server.overseer} refreshKey={0} />)
    await settle()
    expect(state()).toBe('Disconnected')
    // The same dead session is not retried on a status refresh.
    await view.render(<BrowserPane overseer={server.overseer} refreshKey={1} />)
    await settle()
    expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(1)
    // The agent's next turn launched a fresh browser.
    server.setStatus({ sessionId: 's2', state: 'idle' })
    await view.render(<BrowserPane overseer={server.overseer} refreshKey={2} />)
    await settle()
    await settle()
    expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(2)
    expect(frame()?.getAttribute('src')).toBe(LINK_S2.url)
    expect(document.body.textContent).not.toContain(DISCONNECTED_COPY)
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

  describe('tabs', () => {
    const PORTAL: BrowserPaneTab = { id: 'AAA', title: 'Portal', host: 'portal.example.com' }
    const SIGN_IN: BrowserPaneTab = { id: 'BBB', title: '', host: 'login.example.com' }
    const BLANK: BrowserPaneTab = { id: 'CCC', title: '', host: '' }
    const urlFor = (tabId: string) => `https://dispatch.example/gatekeeper/browser/live/${tabId.toLowerCase()}`
    const linkFor = (tabId: string, access: 'watch' | 'control' = 'watch'): BrowserPaneLink =>
      ({ ok: true, sessionId: 's1', url: urlFor(tabId), expiresAt: '2026-01-01T00:00:00.000Z', access, tabId })
    function tabButtons(): HTMLButtonElement[] {
      return Array.from(document.querySelectorAll('[data-testid="browser-pane-tabs"] button'))
    }
    function tabButton(label: string): HTMLButtonElement {
      const found = tabButtons().find(b => b.textContent === label)
      if (!found) throw new Error(`no tab ${label}`)
      return found
    }

    it('shows a strip only when the browser has more than one tab, each named by its title or host', async () => {
      const server = fakeOverseer({ sessionId: 's1', state: 'idle', tabs: [PORTAL], tabId: 'AAA' }, [linkFor('AAA'), linkFor('CCC')])
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={0} />)
      await settle()
      expect(document.querySelector('[data-testid="browser-pane-tabs"]')).toBeNull()

      server.setStatus({ sessionId: 's1', state: 'idle', tabs: [PORTAL, SIGN_IN, BLANK], tabId: 'CCC' })
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={1} />)
      await settle()
      expect(tabButtons().map(b => b.textContent)).toEqual(['Portal', 'login.example.com', 'New tab'])
      expect(tabButton('New tab').getAttribute('aria-pressed')).toBe('true')
    })

    it('frames the default tab, then the tab the person picks, and keeps their pick when the default moves', async () => {
      const server = fakeOverseer({ sessionId: 's1', state: 'idle', tabs: [PORTAL, SIGN_IN], tabId: 'BBB' }, [linkFor('BBB'), linkFor('AAA')])
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={0} />)
      await settle()
      expect(server.mintBrowserPaneLink).toHaveBeenLastCalledWith({ tabId: 'BBB' })
      expect(frame()?.getAttribute('src')).toBe(urlFor('BBB'))

      await act(async () => { tabButton('Portal').click() })
      await settle()
      expect(server.mintBrowserPaneLink).toHaveBeenLastCalledWith({ tabId: 'AAA' })
      expect(frame()?.getAttribute('src')).toBe(urlFor('AAA'))
      expect(tabButton('Portal').getAttribute('aria-pressed')).toBe('true')
      expect(access()).toBe('Watch only')

      // The agent opens another tab: the default moves, the person's pick does not.
      server.setStatus({ sessionId: 's1', state: 'idle', tabs: [PORTAL, SIGN_IN, BLANK], tabId: 'CCC' })
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={1} />)
      await settle()
      expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(2)
      expect(frame()?.getAttribute('src')).toBe(urlFor('AAA'))
    })

    it('follows the newest tab until the person picks one', async () => {
      const server = fakeOverseer({ sessionId: 's1', state: 'idle', tabs: [PORTAL], tabId: 'AAA' }, [linkFor('AAA'), linkFor('BBB')])
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={0} />)
      await settle()
      server.setStatus({ sessionId: 's1', state: 'idle', tabs: [PORTAL, SIGN_IN], tabId: 'BBB' })
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={1} />)
      await settle()
      expect(server.mintBrowserPaneLink).toHaveBeenLastCalledWith({ tabId: 'BBB' })
      expect(frame()?.getAttribute('src')).toBe(urlFor('BBB'))
    })

    it("opens on the handoff's page when the person is handed the browser, whatever they were watching", async () => {
      const server = fakeOverseer({ sessionId: 's1', state: 'idle', tabs: [PORTAL, SIGN_IN], tabId: 'BBB' },
        [linkFor('BBB'), linkFor('AAA'), linkFor('BBB', 'control')])
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={0} />)
      await settle()
      await act(async () => { tabButton('Portal').click() })
      await settle()
      server.setStatus({ sessionId: 's1', state: 'waiting', youControl: true, instructions: 'Sign in', tabs: [PORTAL, SIGN_IN], tabId: 'BBB' })
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={1} />)
      await settle()
      expect(server.mintBrowserPaneLink).toHaveBeenLastCalledWith({ tabId: 'BBB' })
      expect(access()).toBe('You can drive')
      expect(tabButton('login.example.com').getAttribute('aria-pressed')).toBe('true')
    })

    it('follows the default when the picked tab has closed before its link was minted', async () => {
      const server = fakeOverseer({ sessionId: 's1', state: 'idle', tabs: [PORTAL, SIGN_IN], tabId: 'BBB' }, [linkFor('BBB'), linkFor('BBB')])
      await view.render(<BrowserPane overseer={server.overseer} />)
      await settle()
      await act(async () => { tabButton('Portal').click() })
      await settle()
      expect(server.mintBrowserPaneLink).toHaveBeenLastCalledWith({ tabId: 'AAA' })
      expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(2)
      expect(tabButton('login.example.com').getAttribute('aria-pressed')).toBe('true')
    })

    it('marks the tab actually on screen when Browser Run opened another than the one asked for', async () => {
      const server = fakeOverseer({ sessionId: 's1', state: 'idle', tabs: [PORTAL, SIGN_IN], tabId: 'BBB' }, [linkFor('AAA'), linkFor('AAA')])
      await view.render(<BrowserPane overseer={server.overseer} />)
      await settle()
      expect(frame()?.getAttribute('src')).toBe(urlFor('AAA'))
      expect(tabButton('Portal').getAttribute('aria-pressed')).toBe('true')
      expect(tabButton('login.example.com').getAttribute('aria-pressed')).toBe('false')
      // One more try for the default, then it settles on what Browser Run can open.
      expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(2)
    })

    it('re-reads the tabs while someone is looking, so a sign-in popup appears without a turn ending', async () => {
      vi.useFakeTimers()
      const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      try {
        const server = fakeOverseer({ sessionId: 's1', state: 'waiting', youControl: true, tabs: [PORTAL], tabId: 'AAA' },
          [linkFor('AAA', 'control')])
        await view.render(<BrowserPane overseer={server.overseer} />)
        await settle()
        expect(server.getBrowserPane).toHaveBeenCalledTimes(1)
        server.setStatus({ sessionId: 's1', state: 'waiting', youControl: true, tabs: [PORTAL, SIGN_IN], tabId: 'AAA' })
        await act(async () => { vi.advanceTimersByTime(STATUS_REFRESH_MS) })
        await settle()
        expect(server.getBrowserPane).toHaveBeenCalledTimes(2)
        expect(tabButtons().map(b => b.textContent)).toEqual(['Portal', 'login.example.com'])
        // The handoff's page stays framed; the person switches when they choose to.
        expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(1)
        // Only the open pane asks for tabs, which cost a call to Browser Run.
        expect(server.getBrowserPane).toHaveBeenCalledWith({ tabs: true })
      } finally {
        focused.mockRestore()
        vi.useRealTimers()
      }
    })

    const WIKI: BrowserPaneTab = { id: 'WIKI', title: 'Wikipedia', host: 'en.wikipedia.org' }
    const POPUP: BrowserPaneTab = { id: 'POPUP', title: 'Sign in', host: 'login.example.com' }
    const note = () => document.querySelector('[data-testid="browser-pane-behind"]')
    const bringButton = () => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Bring this tab to the front'))

    it('frames a tab a watcher picks behind the one in front, and says it may look blank rather than hiding it', async () => {
      const server = fakeOverseer(
        { sessionId: 's1', state: 'idle', tabs: [WIKI, POPUP], frontTabId: 'POPUP', tabId: 'POPUP' }, [linkFor('POPUP'), linkFor('WIKI'), linkFor('POPUP')])
      await view.render(<BrowserPane overseer={server.overseer} />)
      await settle()
      // The strip starts on the tab in front, with nothing to warn about.
      expect(tabButton('Sign in').getAttribute('aria-pressed')).toBe('true')
      expect(note()).toBeNull()

      await act(async () => { tabButton('Wikipedia').click() })
      await settle()
      // A wrong record must never hide a tab that would render: it is framed, read-only as before.
      expect(server.mintBrowserPaneLink).toHaveBeenLastCalledWith({ tabId: 'WIKI' })
      expect(frame()?.getAttribute('src')).toBe(urlFor('WIKI'))
      expect(frame()?.classList.contains('hidden')).toBe(false)
      expect(note()?.textContent).toContain(BEHIND_COPY)
      // A watcher cannot change the agent's browser.
      expect(bringButton()).toBeUndefined()

      await act(async () => { tabButton('Sign in').click() })
      await settle()
      expect(note()).toBeNull()
    })

    it('follows the tab in front as it changes, and warns a watcher who stays on the one left behind', async () => {
      const server = fakeOverseer({ sessionId: 's1', state: 'idle', tabs: [WIKI], frontTabId: 'WIKI', tabId: 'WIKI' },
        [linkFor('WIKI'), linkFor('POPUP'), linkFor('WIKI')])
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={0} />)
      await settle()
      // A popup opens in front: the watcher who chose nothing follows it.
      server.setStatus({ sessionId: 's1', state: 'idle', tabs: [WIKI, POPUP], frontTabId: 'POPUP', tabId: 'POPUP' })
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={1} />)
      await settle()
      expect(server.mintBrowserPaneLink).toHaveBeenLastCalledWith({ tabId: 'POPUP' })
      expect(frame()?.getAttribute('src')).toBe(urlFor('POPUP'))
      // A watcher who goes back to the first page gets it, with the note.
      await act(async () => { tabButton('Wikipedia').click() })
      await settle()
      expect(frame()?.getAttribute('src')).toBe(urlFor('WIKI'))
      expect(document.body.textContent).toContain(BEHIND_COPY)
    })

    it('does not flash the note at a watcher following the tab in front while the new frame is minted', async () => {
      let current: BrowserPaneStatus = { sessionId: 's1', state: 'idle', tabs: [WIKI], frontTabId: 'WIKI', tabId: 'WIKI' }
      let release!: (link: BrowserPaneLink) => void
      const mintBrowserPaneLink = vi.fn()
        .mockResolvedValueOnce(linkFor('WIKI'))
        .mockImplementationOnce(() => new Promise<BrowserPaneLink>(resolve => { release = resolve }))
      const overseer = { getBrowserPane: vi.fn(async () => current), mintBrowserPaneLink } as unknown as RpcStub<Overseer>
      await view.render(<BrowserPane overseer={overseer} refreshKey={0} />)
      await settle()
      // A popup opens in front; the watcher follows it, and its link is on its way.
      current = { sessionId: 's1', state: 'idle', tabs: [WIKI, POPUP], frontTabId: 'POPUP', tabId: 'POPUP' }
      await view.render(<BrowserPane overseer={overseer} refreshKey={1} />)
      await settle()
      expect(mintBrowserPaneLink).toHaveBeenLastCalledWith({ tabId: 'POPUP' })
      expect(frame()?.getAttribute('src')).toBe(urlFor('WIKI'))
      expect(note()).toBeNull()
      await act(async () => { release(linkFor('POPUP')) })
      await settle()
      expect(frame()?.getAttribute('src')).toBe(urlFor('POPUP'))
      expect(note()).toBeNull()
    })

    it("does not warn the person driving about the tab they just picked: the gatekeeper brought it forward", async () => {
      const server = fakeOverseer(
        { sessionId: 's1', state: 'waiting', youControl: true, tabs: [WIKI, POPUP], frontTabId: 'POPUP', tabId: 'POPUP' },
        [linkFor('POPUP', 'control'), { ...linkFor('WIKI', 'control'), front: true } as BrowserPaneLink])
      await view.render(<BrowserPane overseer={server.overseer} />)
      await settle()
      await act(async () => { tabButton('Wikipedia').click() })
      await settle()
      expect(server.mintBrowserPaneLink).toHaveBeenLastCalledWith({ tabId: 'WIKI' })
      expect(frame()?.getAttribute('src')).toBe(urlFor('WIKI'))
      expect(note()).toBeNull()
    })

    it('offers the person driving "Bring this tab to the front" when a popup opens in front of their tab', async () => {
      const POPUP2: BrowserPaneTab = { id: 'POPUP2', title: 'Consent', host: 'consent.example.com' }
      const drove = (tabId: string) => ({ ...linkFor(tabId, 'control'), front: true }) as BrowserPaneLink
      const server = fakeOverseer(
        { sessionId: 's1', state: 'waiting', youControl: true, tabs: [WIKI, POPUP], frontTabId: 'POPUP', tabId: 'POPUP' },
        [drove('POPUP'), drove('WIKI'), drove('WIKI')])
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={0} />)
      await settle()
      // The person picks the first page; the gatekeeper brings it forward.
      await act(async () => { tabButton('Wikipedia').click() })
      await settle()
      expect(note()).toBeNull()
      // The page opens another popup in front of it.
      server.setStatus({ sessionId: 's1', state: 'waiting', youControl: true, tabs: [WIKI, POPUP, POPUP2], frontTabId: 'POPUP2', tabId: 'POPUP2' })
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={1} />)
      await settle()
      expect(frame()?.getAttribute('src')).toBe(urlFor('WIKI'))
      expect(note()?.textContent).toContain(BEHIND_COPY)
      expect(bringButton()).toBeDefined()

      await act(async () => { bringButton()!.click() })
      await settle()
      expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(3)
      expect(server.mintBrowserPaneLink).toHaveBeenLastCalledWith({ tabId: 'WIKI' })
      expect(note()).toBeNull()
    })

    it("frames Browser Run's own choice when nothing is known to be in front, and marks it", async () => {
      const server = fakeOverseer({ sessionId: 's1', state: 'idle', tabs: [PORTAL, SIGN_IN] }, [linkFor('BBB')])
      await view.render(<BrowserPane overseer={server.overseer} />)
      await settle()
      expect(server.mintBrowserPaneLink).toHaveBeenLastCalledWith({})
      expect(tabButton('login.example.com').getAttribute('aria-pressed')).toBe('true')
      expect(document.body.textContent).not.toContain(BEHIND_COPY)
    })

    it('stops re-reading while the page is hidden or the window is not focused, since a listing may keep the browser alive', async () => {
      vi.useFakeTimers()
      const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      try {
        const server = fakeOverseer({ sessionId: 's1', state: 'idle', tabs: [PORTAL], tabId: 'AAA' }, [linkFor('AAA')])
        await view.render(<BrowserPane overseer={server.overseer} />)
        await settle()
        await act(async () => { vi.advanceTimersByTime(STATUS_REFRESH_MS * 3) })
        expect(server.getBrowserPane).toHaveBeenCalledTimes(1)

        visibility.mockReturnValue('visible')
        focused.mockReturnValue(false)
        await act(async () => { vi.advanceTimersByTime(STATUS_REFRESH_MS * 3) })
        expect(server.getBrowserPane).toHaveBeenCalledTimes(1)

        focused.mockReturnValue(true)
        await act(async () => { vi.advanceTimersByTime(STATUS_REFRESH_MS) })
        expect(server.getBrowserPane).toHaveBeenCalledTimes(2)
      } finally {
        visibility.mockRestore()
        focused.mockRestore()
        vi.useRealTimers()
      }
    })
  })

  describe('when Browser Run is busy', () => {
    it('keeps what is on screen and says so for now, never that the browser is gone', async () => {
      const server = fakeOverseer({ sessionId: 's1', state: 'idle' }, [LINK_A, { ok: false, reason: 'unavailable' }])
      await view.render(<BrowserPane overseer={server.overseer} />)
      await settle()
      await act(async () => { button('New link').click() })
      await settle()
      expect(state()).toBe('Unavailable')
      expect(frame()?.getAttribute('src')).toBe(LINK_A.url)
      expect(document.body.textContent).not.toContain(DISCONNECTED_COPY)
    })
  })

  describe('developer view', () => {
    const DEV_URL = 'https://dispatch.example/gatekeeper/browser/live/dddd'
    const LINK_DEV: BrowserPaneLink = { ...LINK_CONTROL, url: DEV_URL, developer: true }
    function developerButton(): HTMLButtonElement | undefined {
      return Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Developer view'))
    }

    it('is offered to the person driving, frames developer tools on request, and goes back to the page', async () => {
      const server = fakeOverseer({ sessionId: 's1', state: 'waiting', youControl: true }, [LINK_CONTROL, LINK_DEV, LINK_CONTROL])
      await view.render(<BrowserPane overseer={server.overseer} />)
      await settle()
      expect(developerButton()?.getAttribute('aria-pressed')).toBe('false')
      await act(async () => { developerButton()!.click() })
      await settle()
      expect(server.mintBrowserPaneLink).toHaveBeenLastCalledWith({ developer: true })
      expect(frame()?.getAttribute('src')).toBe(DEV_URL)
      expect(developerButton()?.getAttribute('aria-pressed')).toBe('true')
      await act(async () => { developerButton()!.click() })
      await settle()
      expect(server.mintBrowserPaneLink).toHaveBeenLastCalledWith({})
      expect(frame()?.getAttribute('src')).toBe('https://dispatch.example/gatekeeper/browser/live/cccc')
    })

    it("says to switch back to the page view to press Done, since the developer tools cover Cloudflare's panel", async () => {
      const server = fakeOverseer({ sessionId: 's1', state: 'waiting', youControl: true, instructions: 'Sign in' },
        [LINK_CONTROL, LINK_DEV, LINK_CONTROL])
      await view.render(<BrowserPane overseer={server.overseer} />)
      await settle()
      const hint = () => document.querySelector('[data-testid="browser-pane-developer-done"]')?.textContent
      expect(hint()).toBeUndefined()
      await act(async () => { developerButton()!.click() })
      await settle()
      expect(hint()).toBe(DEVELOPER_DONE_COPY)
      await act(async () => { developerButton()!.click() })
      await settle()
      expect(hint()).toBeUndefined()
    })

    it('never goes to a new tab: "Open in new tab" is hidden while it is on', async () => {
      const server = fakeOverseer({ sessionId: 's1', state: 'waiting', youControl: true }, [LINK_CONTROL, LINK_DEV, LINK_CONTROL])
      await view.render(<BrowserPane overseer={server.overseer} />)
      await settle()
      const openButton = () => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Open in new tab'))
      expect(openButton()).toBeDefined()
      await act(async () => { developerButton()!.click() })
      await settle()
      expect(frame()?.getAttribute('src')).toBe(DEV_URL)
      expect(openButton()).toBeUndefined()
      await act(async () => { developerButton()!.click() })
      await settle()
      expect(openButton()).toBeDefined()
    })

    it("leaves the page at the end of the person's turn, looking or not, and a watching frame replaces it", async () => {
      vi.useFakeTimers()
      try {
        const endsAt = new Date(Date.now() + 60_000).toISOString()
        const server = fakeOverseer({ sessionId: 's1', state: 'waiting', youControl: true, endsAt }, [LINK_CONTROL, LINK_DEV, LINK_B])
        await view.render(<BrowserPane overseer={server.overseer} />)
        await settle()
        await act(async () => { developerButton()!.click() })
        await settle()
        expect(frame()?.getAttribute('src')).toBe(DEV_URL)
        // The handoff ends; no agent turn ends and the window is not focused, so only the turn's
        // own end prompts the pane to ask.
        server.setStatus({ sessionId: 's1', state: 'idle' })
        await act(async () => { vi.advanceTimersByTime(61_000) })
        await settle()
        expect(server.getBrowserPane).toHaveBeenCalledTimes(2)
        expect(frame()?.getAttribute('src')).toBe(LINK_B.url)
        expect(access()).toBe('Watch only')
        expect(developerButton()).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('takes a driving frame off the page when the turn ends, even if no watching frame can replace it', async () => {
      for (const failed of [{ ok: false, reason: 'unavailable' }, { ok: false, reason: 'watch-unavailable' }] as BrowserPaneLink[]) {
        const server = fakeOverseer({ sessionId: 's1', state: 'waiting', youControl: true }, [LINK_CONTROL, LINK_DEV, failed])
        await view.render(<BrowserPane overseer={server.overseer} refreshKey={0} />)
        await settle()
        await act(async () => { developerButton()!.click() })
        await settle()
        expect(frame()?.getAttribute('src')).toBe(DEV_URL)
        server.setStatus({ sessionId: 's1', state: 'waiting', youControl: false })
        await view.render(<BrowserPane overseer={server.overseer} refreshKey={1} />)
        await settle()
        expect(frame()).toBeNull()
        expect(document.body.innerHTML).not.toContain(DEV_URL)
        view.cleanup()
      }
    })

    it('is never offered to a watcher, and ends with the handoff', async () => {
      const watcher = fakeOverseer({ sessionId: 's1', state: 'waiting', youControl: false }, [LINK_A])
      await view.render(<BrowserPane overseer={watcher.overseer} />)
      await settle()
      expect(developerButton()).toBeUndefined()
      view.cleanup()

      const server = fakeOverseer({ sessionId: 's1', state: 'waiting', youControl: true }, [LINK_CONTROL, LINK_DEV, LINK_B])
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={0} />)
      await settle()
      await act(async () => { developerButton()!.click() })
      await settle()
      server.setStatus({ sessionId: 's1', state: 'idle' })
      await view.render(<BrowserPane overseer={server.overseer} refreshKey={1} />)
      await settle()
      expect(server.mintBrowserPaneLink).toHaveBeenLastCalledWith({})
      expect(access()).toBe('Watch only')
      expect(developerButton()).toBeUndefined()
    })
  })

  describe('full screen', () => {
    function pane(): HTMLElement {
      return document.querySelector('[data-testid="browser-pane"]') as HTMLElement
    }
    function iconButton(label: string): HTMLButtonElement {
      const found = document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null
      if (!found) throw new Error(`no button ${label}`)
      return found
    }

    it('covers the workspace and comes back with Esc or the same button, without reloading the frame', async () => {
      const server = fakeOverseer({ sessionId: 's1', state: 'idle' }, [LINK_A])
      await view.render(<BrowserPane overseer={server.overseer} />)
      await settle()
      const framed = frame()
      expect(pane().getAttribute('role')).toBeNull()

      await act(async () => { iconButton('Enter full screen').click() })
      expect(pane().getAttribute('role')).toBe('dialog')
      expect(pane().className).toContain('visual-viewport-fixed')
      expect(document.body.textContent).toContain('to exit full screen')
      expect(frame()).toBe(framed)

      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
      expect(pane().getAttribute('role')).toBeNull()
      expect(pane().className).not.toContain('visual-viewport-fixed')

      await act(async () => { iconButton('Enter full screen').click() })
      await act(async () => { iconButton('Exit full screen').click() })
      expect(pane().getAttribute('role')).toBeNull()
      expect(frame()).toBe(framed)
      expect(server.mintBrowserPaneLink).toHaveBeenCalledTimes(1)
    })

    it('has nothing to enlarge before there is a frame', async () => {
      const server = fakeOverseer({ state: 'none' }, [])
      await view.render(<BrowserPane overseer={server.overseer} />)
      await settle()
      expect(iconButton('Enter full screen').disabled).toBe(true)
    })
  })
})

