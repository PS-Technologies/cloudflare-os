// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  pathname: '/',
  search: {} as Record<string, unknown>,
  isLoading: false,
  cfAccess: false,
  // A signed-in tab's stub: the shell would call this first, so a popup routed into the shell by
  // mistake shows up as a call here.
  authenticatedApi: null as { isOnboardingCompleted: () => Promise<boolean> } | null,
}))

// The root decides standalone-vs-shell from the pathname and the auth state alone; both are faked
// here, and the routed page is a marker so no real screen renders.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string; search: unknown } }) => unknown }) =>
    select({ location: { pathname: testState.pathname, search: testState.search } }),
  Outlet: () => <div data-testid="outlet">routed page</div>,
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}))

vi.mock('./useAuth', () => ({
  get CF_ACCESS_MODE() { return testState.cfAccess },
  useAuth: () => ({
    isAuthenticated: testState.authenticatedApi !== null,
    authenticatedApi: testState.authenticatedApi,
    isLoading: testState.isLoading,
    error: null,
    login: vi.fn<(token: string) => void>(),
    logout: vi.fn<() => void>(),
  }),
}))

vi.mock('./components/Header', () => ({ default: () => <header data-testid="header">Header</header> }))
vi.mock('./LoginPage', () => ({ default: () => <div data-testid="login">Login</div> }))

// Principle: past sign-in, the shell's providers and bridges are faked too, so the signed-in tests
// see only where the rail goes.
vi.mock('./AuthContext', async () => {
  const { createContext, createElement, useContext } = await import('react')
  const signedIn = { currentUser: { type: 'user', id: 'will@principlesvc.com', name: 'Will Grey' } }
  const Context = createContext<typeof signedIn | null>(null)
  return {
    AuthProvider: ({ children }: { children: ReactNode }) => createElement(Context.Provider, { value: signedIn }, children),
    useAuthenticatedApi: () => signedIn,
    useOptionalAuthenticatedApi: () => useContext(Context),
  }
})
vi.mock('./FeatureFlagsContext', () => ({
  FeatureFlagsProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./features/notifications/NotificationBridge', () => ({ NotificationBridge: () => null }))
vi.mock('./features/notifications/BrowserPushBridge', () => ({ BrowserPushBridge: () => null }))
vi.mock('./features/native-app/NativeAppBridge', () => ({ NativeAppBridge: () => null }))
vi.mock('./components/billing/AccountSelectionModal', () => ({ default: () => null }))
vi.mock('./components/AppShell/AppShell', () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="app-shell">{children}</div>,
}))

import { Route } from './routes/__root'
import { RpcContext } from './RpcContext'
import { ThemeProvider } from './ThemeContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RootComponent = Route.options.component as ComponentType

// Principle: the rail every Principle app wears (components/PrincipleRail.tsx). AppShell carries it
// everywhere but a workspace, which has no shell, so the root puts it there.
describe('root route signed in', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const stub = {} as RpcStub<PublicApi>

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    testState.pathname = '/'
    testState.authenticatedApi = null
    document.cookie = 'ps-theme=; Max-Age=0; Path=/'
  })

  async function renderSignedInAt(pathname: string) {
    testState.pathname = pathname
    testState.authenticatedApi = { isOnboardingCompleted: vi.fn<() => Promise<boolean>>().mockResolvedValue(true) }
    document.cookie = 'ps-theme=light; Path=/'
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <RpcContext.Provider value={{ stub, connectionLost: false }}>
          <ThemeProvider>
            <RootComponent />
          </ThemeProvider>
        </RpcContext.Provider>,
      )
    })
    return container
  }

  it('puts the rail beside a workspace from md up, with Dispatch selected', async () => {
    const page = await renderSignedInAt('/workspace/w1')

    const rail = page.querySelector('nav[aria-label="Principle"]')!
    const column = rail.parentElement!
    expect(column.classList.contains('hidden')).toBe(true)
    expect(column.classList.contains('md:flex')).toBe(true)
    expect(column.nextElementSibling?.querySelector('[data-testid="outlet"]')).not.toBeNull()
    expect(rail.querySelector('[aria-current="page"]')?.textContent).toBe('Dispatch')
    expect(rail.querySelector('.ps-rail-avatar')?.textContent).toBe('WG')
    const card = column.nextElementSibling!
    expect(column.parentElement?.classList.contains('bg-[var(--sidebar)]')).toBe(true)
    for (const cls of ['md:m-2', 'md:ml-0', 'md:rounded-[12px]', 'md:border-[var(--line)]', 'md:bg-[var(--bg)]']) {
      expect(card.classList.contains(cls)).toBe(true)
    }
  })

  it('leaves the rail to AppShell everywhere else', async () => {
    const page = await renderSignedInAt('/')

    expect(page.querySelector('[data-testid="app-shell"] [data-testid="outlet"]')).not.toBeNull()
    expect(page.querySelector('nav[aria-label="Principle"]')).toBeNull()
  })
})

const signIn = (onboarded: Promise<boolean>) => {
  testState.authenticatedApi = { isOnboardingCompleted: () => onboarded }
}
const bubble = (page: HTMLElement) => page.querySelector('.bg-kumo-bubble-user')
const spinner = (page: HTMLElement) => page.querySelector('.animate-spin')

/** The frame's outer boxes: the page, the rail's column and the card beside it. */
function frameBoxes(page: HTMLElement) {
  const column = page.querySelector('nav[aria-label="Principle"]')!.parentElement!
  return [column.parentElement!.className, column.className, column.nextElementSibling!.className]
}

// Principle: home's Ask Watts opens Dispatch at /start (routes/start.tsx). From the first frame the
// person sees their question and Watts thinking in the workspace's own frame, so the root shows
// that frame where it would show a spinner while sign-in or the onboarding check is under way.
describe('root route at /start with a question from home', () => {
  const QUESTION = 'Summarize the LCRA T-FCC bid'
  const OPENED = `https://dispatch.principlesvc.app/?${new URLSearchParams({ prompt: JSON.stringify(QUESTION), send: '1' })}`
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const stub = {} as RpcStub<PublicApi>

  function arrive(referrer: string) {
    Object.defineProperty(document, 'referrer', { value: referrer, configurable: true })
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
      [{ name: OPENED, type: 'navigate' } as unknown as PerformanceEntry])
  }

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    Object.assign(testState, { pathname: '/', search: {}, isLoading: false, cfAccess: false, authenticatedApi: null })
    Reflect.deleteProperty(document, 'referrer')
    document.cookie = 'ps-theme=; Max-Age=0; Path=/'
    vi.restoreAllMocks()
  })

  async function renderRoot({ pathname = '/start', search = { prompt: QUESTION } as Record<string, unknown> } = {}) {
    Object.assign(testState, { pathname, search })
    document.cookie = 'ps-theme=light; Path=/'
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <RpcContext.Provider value={{ stub, connectionLost: false }}>
          <ThemeProvider>
            <RootComponent />
          </ThemeProvider>
        </RpcContext.Provider>,
      )
    })
    return container
  }

  it('shows the question and Watts thinking in the workspace frame while the connection signs in', async () => {
    arrive('https://home.principlesvc.app/')
    testState.isLoading = true
    const page = await renderRoot()

    expect(bubble(page)?.textContent).toBe(QUESTION)
    expect(page.textContent).toContain('Thinking')
    expect(page.textContent).not.toContain('Loading...')
    expect(spinner(page)).toBeNull()
    expect(page.querySelector('a[aria-label="Back to Dispatch"]')).not.toBeNull()
    // Nobody is signed in yet, so the rail has no initials to show.
    expect(page.querySelector('.ps-rail-avatar')?.textContent).toBe('')
  })

  it('shows it while Cloudflare Access signs the person in', async () => {
    arrive('https://home.principlesvc.app/')
    testState.cfAccess = true
    const page = await renderRoot()

    expect(bubble(page)?.textContent).toBe(QUESTION)
    expect(page.textContent).not.toContain('Authenticating...')
  })

  it('shows it while the onboarding check is under way', async () => {
    arrive('https://home.principlesvc.app/')
    signIn(new Promise(() => {}))
    const page = await renderRoot()

    expect(bubble(page)?.textContent).toBe(QUESTION)
    expect(spinner(page)).toBeNull()
    expect(page.querySelector('[data-testid="outlet"]')).toBeNull()
  })

  it('then hands over to /start itself, fullscreen beside the rail, in the same boxes', async () => {
    arrive('https://home.principlesvc.app/')
    testState.isLoading = true
    const before = frameBoxes(await renderRoot())
    act(() => root?.unmount())

    testState.isLoading = false
    signIn(Promise.resolve(true))
    const page = await renderRoot()
    expect(page.querySelector('[data-testid="app-shell"]')).toBeNull()
    const column = page.querySelector('nav[aria-label="Principle"]')!.parentElement!
    expect(column.nextElementSibling?.querySelector('[data-testid="outlet"]')).not.toBeNull()
    expect(frameBoxes(page)).toEqual(before)
  })

  it.each([
    ['any other page', () => renderRoot({ pathname: '/' }), 'https://home.principlesvc.app/'],
    ['a /start it was not handed by home', () => renderRoot(), 'https://evil.example/'],
    ['a /start with no question', () => renderRoot({ search: {} }), 'https://home.principlesvc.app/'],
  ])('keeps its spinners for %s', async (_case, render, referrer) => {
    arrive(referrer)
    testState.isLoading = true
    let page = await render()
    expect(page.textContent).toContain('Loading...')
    expect(bubble(page)).toBeNull()
    act(() => root?.unmount())

    testState.isLoading = false
    testState.cfAccess = true
    page = await render()
    expect(page.textContent).toContain('Authenticating...')
    expect(bubble(page)).toBeNull()
    act(() => root?.unmount())

    testState.cfAccess = false
    signIn(new Promise(() => {}))
    page = await render()
    expect(spinner(page)).not.toBeNull()
    expect(bubble(page)).toBeNull()
  })
})
