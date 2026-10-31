// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({ useRouterState: () => '/' }))

vi.mock('../../RpcContext', () => ({ useConnectionLost: () => false }))
vi.mock('../../TopBarNotice', () => ({ default: () => null }))
vi.mock('./CommandPalette', () => ({ default: () => null }))
vi.mock('./Sidebar', () => ({
  default: () => <aside data-testid="sidebar" />,
}))
vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({
    currentUser: { type: 'user', id: 'will@principlesvc.com', name: 'Will Grey' },
  }),
}))

import AppShell from './AppShell'
import { ThemeProvider } from '../../ThemeContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AppShell', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.useRealTimers()
    document.cookie = 'ps-theme=; Max-Age=0; Path=/'
    vi.unstubAllGlobals()
  })

  function render() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(<ThemeProvider><AppShell><div /></AppShell></ThemeProvider>))
    return container
  }


  // Principle: the rail every Principle app wears (PrincipleRail.tsx).
  it("wears Principle's rail left of everything from md up, with Dispatch selected and who is signed in", () => {
    const page = render()

    const column = page.firstElementChild!.firstElementChild!
    const rail = column.querySelector('nav[aria-label="Principle"]')!
    expect(column.classList.contains('hidden')).toBe(true)
    expect(column.classList.contains('md:flex')).toBe(true)
    expect(rail.getAttribute('data-variant')).toBe('column')
    expect([...rail.querySelectorAll('[aria-current="page"]')].map((a) => a.textContent)).toEqual(['Dispatch'])
    expect(rail.querySelector('.ps-rail-avatar')?.textContent).toBe('WG')
  })

  it("steps the Workshop's theme light, navy, charcoal and saves each in the ps-theme cookie", () => {
    document.cookie = 'ps-theme=light; Path=/'
    const page = render()
    const button = () => page.querySelector<HTMLButtonElement>('nav[aria-label="Principle"] button')!

    const steps = [1, 2, 3].map(() => {
      act(() => button().click())
      return [document.documentElement.dataset.theme, /ps-theme=(\w+)/.exec(document.cookie)?.[1]]
    })
    expect(steps).toEqual([['dark', 'dark'], ['charcoal', 'charcoal'], ['light', 'light']])
    expect(button().getAttribute('aria-label')).toBe('Theme: light. Switch to navy')
  })

  it('carries the rail in the mobile drawer, left of the sidebar', () => {
    const page = render()
    expect(page.querySelector('nav[data-variant="drawer"]')).toBeNull()

    act(() => page.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')!.click())

    const drawer = page.querySelector('[role="dialog"][aria-label="Primary navigation"]')!
    const [rail, sidebar] = [...drawer.children]
    expect(rail.matches('nav[aria-label="Principle"][data-variant="drawer"]')).toBe(true)
    expect(rail.querySelector('[aria-current="page"]')?.textContent).toBe('Dispatch')
    expect(sidebar.getAttribute('data-testid')).toBe('sidebar')
  })

  it('puts the page inside the inset card on the rail floor', () => {
    const page = render()
    expect(page.firstElementChild?.classList.contains('bg-[var(--sidebar)]')).toBe(true)
    const card = page.querySelector('main')!.parentElement!
    for (const cls of ['md:m-2', 'md:ml-0', 'md:rounded-[12px]', 'md:border', 'md:border-[var(--line)]', 'md:bg-[var(--bg)]', 'md:overflow-hidden']) {
      expect(card.classList.contains(cls)).toBe(true)
    }
  })

  it('collapses completely, restores from the canvas and remembers the choice', () => {
    const page = render()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })))
    const panel = page.querySelector('[data-panel]')!
    expect(panel.getAttribute('data-state')).toBe('collapsed')
    expect(panel.hasAttribute('inert')).toBe(true)
    expect(page.querySelector('[data-panel-spacer]')?.getAttribute('style')).toContain('width: 0px')
    expect(localStorage.getItem('gadgets:sidebar-collapsed')).toBe('1')
    const toggle = page.querySelector<HTMLButtonElement>('button[aria-label="Dock sidebar"]')!
    expect(toggle).not.toBeNull()
    act(() => toggle.click())
    expect(panel.getAttribute('data-state')).toBe('docked')
    expect(localStorage.getItem('gadgets:sidebar-collapsed')).toBe('0')
  })

  it('reads the stored collapsed choice before paint', () => {
    localStorage.setItem('gadgets:sidebar-collapsed', '1')
    const page = render()
    expect(page.querySelector('[data-panel]')?.getAttribute('data-state')).toBe('collapsed')
    expect(page.querySelector('button[aria-label="Dock sidebar"]')).not.toBeNull()
  })

  it('peeks after 120ms intent and closes after 250ms away or Escape', () => {
    vi.useFakeTimers()
    localStorage.setItem('gadgets:sidebar-collapsed', '1')
    const page = render()
    const edge = page.querySelector('[data-testid="peek-edge"]')!
    const panel = page.querySelector('[data-panel]')!
    act(() => edge.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(119))
    expect(panel.getAttribute('data-state')).toBe('collapsed')
    act(() => vi.advanceTimersByTime(1))
    expect(panel.getAttribute('data-state')).toBe('peeking')
    expect(panel.hasAttribute('inert')).toBe(false)
    act(() => edge.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
    act(() => vi.advanceTimersByTime(249))
    expect(panel.getAttribute('data-state')).toBe('peeking')
    act(() => vi.advanceTimersByTime(1))
    expect(panel.getAttribute('data-state')).toBe('collapsed')
    act(() => edge.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(120))
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(panel.getAttribute('data-state')).toBe('collapsed')
    expect(panel.getAttribute('data-motion')).toBe('instant')
  })


  it('ends a peek before a focused canvas control consumes Escape', () => {
    vi.useFakeTimers()
    localStorage.setItem('gadgets:sidebar-collapsed', '1')
    const page = render()
    const canvas = page.querySelector<HTMLButtonElement>('button[aria-label="Dock sidebar"]')!
    canvas.focus()
    canvas.addEventListener('keydown', (event) => { if (event.key === 'Escape') event.stopPropagation() })
    const edge = page.querySelector('[data-testid="peek-edge"]')!
    act(() => edge.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(120))
    expect(page.querySelector('[data-panel]')?.getAttribute('data-state')).toBe('peeking')
    act(() => canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(page.querySelector('[data-panel]')?.getAttribute('data-state')).toBe('collapsed')
  })

})
