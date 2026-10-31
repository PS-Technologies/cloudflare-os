// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  pathname: '/',
  isLoading: false,
  // A signed-in tab's stub: the shell would call this first, so a popup routed into the shell by
  // mistake shows up as a call here.
  authenticatedApi: null as { isOnboardingCompleted: () => Promise<boolean> } | null,
}))

// The root decides standalone-vs-shell from the pathname and the auth state alone; both are faked
// here, and the routed page is a marker so no real screen renders.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: testState.pathname } }),
  Outlet: () => <div data-testid="outlet">routed page</div>,
}))

vi.mock('./useAuth', () => ({
  CF_ACCESS_MODE: false,
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
vi.mock('./AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuthenticatedApi: () => ({
    currentUser: { type: 'user', id: 'will@principlesvc.com', name: 'Will Grey' },
  }),
}))
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
