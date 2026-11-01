// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useRouterState: () => '/',
  useNavigate: () => () => {},
}))
vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'Dispatch', useServerConfig: () => ({ siteLogo: { url: '/test-logo.svg' } }) }))
vi.mock('../../useGatekeeperApps', () => ({ useGatekeeperApps: () => [] }))
vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ currentUser: { id: 'will@example.test', name: 'Will Grey' }, isAdmin: true }),
}))
vi.mock('../../useAvatar', () => ({ useAvatar: () => undefined }))
vi.mock('./SidebarWorkspaces', () => ({
  SidebarWorkspacesProvider: ({ children }: { children: ReactNode }) => children,
  SidebarWorkspacesTools: () => null,
  SidebarWorkspacesLists: () => null,
}))

import Sidebar from './Sidebar'
import { PrincipleFrameProvider } from './PrincipleFrame'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Sidebar frame', () => {
  let root: Root | undefined
  afterEach(() => act(() => root?.unmount()))

  it('keeps the only badge and initials on the rail and orders search, settings, toggle', () => {
    const container = document.createElement('div')
    root = createRoot(container)
    act(() => root!.render(<PrincipleFrameProvider collapsed={false} onToggleCollapsed={() => {}}><Sidebar collapsed={false} onToggleCollapsed={() => {}} /></PrincipleFrameProvider>))
    const sidebar = container.querySelector('aside')!
    const header = sidebar.firstElementChild!
    expect(header.querySelector('img')).toBeNull()
    expect(sidebar.textContent).not.toContain('WG')
    expect([...header.querySelectorAll('button')].map((el) => el.getAttribute('aria-label'))).toEqual(['Search', 'Settings', 'Collapse sidebar'])
    expect(sidebar.classList.contains('md:w-[248px]')).toBe(true)
    expect(sidebar.classList.contains('border-r')).toBe(false)
    expect(sidebar.querySelector('a[aria-label="Gatekeepers"]')).toBeNull()
  })
})


it.each([{ mobile: false, surface: 'desktop sidebar' }, { mobile: true, surface: 'mobile drawer' }])('provides one labelled Connectors row in the $surface', ({ mobile }) => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<PrincipleFrameProvider collapsed={false} onToggleCollapsed={() => {}}><Sidebar mobile={mobile} collapsed={false} onToggleCollapsed={() => {}} /></PrincipleFrameProvider>))
    const links = container.querySelectorAll('aside nav a[href="/gatekeepers"]')
    expect(links).toHaveLength(1)
    expect(links[0].textContent).toBe('Connectors')
  } finally {
    act(() => root.unmount())
  }
})
