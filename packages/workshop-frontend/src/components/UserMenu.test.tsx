// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ isAdmin: false, logout: vi.fn<() => void>() }))
const navigate = vi.hoisted(() => vi.fn<(options: { to: string }) => void>())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({ ...auth, currentUser: { id: 'will@example.test', name: 'Will Grey' } }),
}))
vi.mock('../useAvatar', () => ({ useAvatar: () => undefined }))

import UserMenu from './UserMenu'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('UserMenu settings', () => {
  let root: Root | undefined
  let container: HTMLDivElement
  beforeEach(() => {
    navigate.mockClear()
    auth.logout.mockClear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
  })

  it.each([false, true])('uses a gear without initials and offers the account actions (admin: %s)', (isAdmin) => {
    auth.isAdmin = isAdmin
    act(() => root!.render(<UserMenu />))
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')
    expect(button).not.toBeNull()
    expect(container.textContent).not.toContain('WG')
    expect(container.querySelector('img')).toBeNull()
    act(() => button!.click())
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items.map((el) => el.textContent)).toEqual(isAdmin ? ['Gatekeepers', 'Profile', 'Providers', 'Admin', 'Sign out'] : ['Gatekeepers', 'Profile', 'Providers', 'Sign out'])
    act(() => items[0].click())
    expect(navigate).toHaveBeenCalledWith({ to: '/gatekeepers' })
  })
})
