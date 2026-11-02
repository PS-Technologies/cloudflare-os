// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

vi.mock('../AuthContext', () => ({ useOptionalAuthenticatedApi: () => undefined }))
vi.mock('../ThemeContext', () => ({ useTheme: () => ({ themeMode: 'light', setThemeMode: vi.fn<() => void>() }) }))

import PrincipleRail from './PrincipleRail'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each(['column', 'drawer'] as const)('puts Sites below Apps in the %s rail, opening home in this tab', (variant) => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<PrincipleRail variant={variant} />))
    const links = [...container.querySelectorAll<HTMLAnchorElement>('.ps-rail-item')]
    expect(links.map((link) => link.textContent)).toEqual(['Home', 'Dispatch', 'Agents', 'Proposal', 'Contracts', 'Apps', 'Sites'])
    const sites = links.at(-1)!
    expect(sites.getAttribute('href')).toBe('https://home.principlesvc.app/sites')
    expect(sites.getAttribute('target')).toBeNull()
    expect(links.filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.textContent)).toEqual(['Dispatch'])
  } finally {
    act(() => root.unmount())
  }
})
