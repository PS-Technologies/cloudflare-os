// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GadgetSummary, WorkspaceMetadata, WorkpiecesSubscriber } from '@gadgets/workshop-shared/api'

// Principle: the frame sets the gadget editor in a card right of the rail, so the divider between
// the chat and the gadget is measured from the editor's own box, not the window's. Everything the
// editor composes is stubbed down to what its layout needs.

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const mocks = vi.hoisted(() => {
  const disposable = { [Symbol.dispose]() {} }
  const gadget = { id: 1, type: 'gadget', title: 'Itinerary', commitId: 'head' } as GadgetSummary
  return {
    workspace: {
      overseer: {
        stub: {
          subscribeToWorkpieces: async (subscriber: WorkpiecesSubscriber) => {
            await subscriber.entry(gadget)
            await subscriber.ready()
            return disposable
          },
          getGadget: () => disposable,
          listHooks: async () => [],
          getBrowserPane: async () => ({ state: 'none' }),
          subscribeToConsoleLogs: async () => disposable,
        },
      },
      metadata: { id: 'workspace', title: 'Trips', role: 'build' } as unknown as WorkspaceMetadata,
      error: null,
      connectionLost: false,
      observerConfig: null,
      retry: () => {},
      cancelObserverConfig: () => {},
      updateTitle: () => {},
    },
    authenticatedApi: {
      whoami: async () => ({ type: 'user', id: 'dev', name: 'Dev' }),
      listWorkspaces: async () => [],
    },
  }
})

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'workspace' }),
  useNavigate: () => () => {},
  useSearch: () => ({}),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
vi.mock('@cloudflare/kumo', () => {
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" role="menuitem" onClick={onClick}>{children}</button>
      ),
      Separator: () => <hr />,
    },
  )
  return { DropdownMenu, useKumoToastManager: () => ({ add: () => {} }) }
})
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }) }))
vi.mock('./RpcContext', () => ({ useConnectionLost: () => false, useRpcStub: () => ({}) }))
vi.mock('./useWorkspaceOpen', () => ({ useWorkspaceOpen: () => mocks.workspace }))
vi.mock('./useActions', () => ({ useActions: () => ({ pending: [] }), useActionEntries: () => {} }))
vi.mock('./errorReporting', () => ({ reportIssue: () => {} }))
vi.mock('./features/blueprint-updates/useBlueprintUpdateAvailable', () => ({ useBlueprintUpdateAvailable: () => false }))
vi.mock('./features/blueprint-updates/UpdateFromBlueprintDialog', () => ({ UpdateFromBlueprintDialog: () => null }))
vi.mock('./ChatInterface', () => ({
  default: ({ onChatCountChange }: { onChatCountChange: (count: number, hasChatZero: boolean) => void }) => {
    useEffect(() => { onChatCountChange(0, false) }, [onChatCountChange])
    return <div>chat pane</div>
  },
}))
vi.mock('./features/code/WorkpieceCodeInterface', () => ({
  default: ({ onHasCodeChange }: { onHasCodeChange: (hasCode: boolean) => void }) => {
    useEffect(() => { onHasCodeChange(true) }, [onHasCodeChange])
    return null
  },
}))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, danger: _danger, ...props }: ComponentProps<'button'> & { danger?: boolean }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopInput: (props: ComponentProps<'input'>) => <input {...props} />,
}))
vi.mock('./WorkpiecePicker', () => ({
  default: () => null,
  WORKPIECE_RAIL_COLLAPSED_WIDTH: 48,
  WORKPIECE_RAIL_EXPANDED_WIDTH: 220,
}))
vi.mock('./components/format/FormatVisuals', () => ({ FormatGlyph: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./Activity', () => ({ default: () => null }))
vi.mock('./ActivityNotifications', () => ({ default: () => null }))
vi.mock('./BlueprintModal', () => ({ default: () => null }))
vi.mock('./Connections', () => ({ default: () => null }))
vi.mock('./GadgetExportMenu', () => ({ default: () => null }))
vi.mock('./GadgetUI', () => ({ default: () => null }))
vi.mock('./GadgetUseView', () => ({ default: () => null }))
vi.mock('./ObserverConfigModal', () => ({ default: () => null }))
vi.mock('./ShareModal', () => ({ default: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))
vi.mock('./components/DeleteConfirmationDialog', () => ({ default: () => null }))
vi.mock('./components/ReconnectingChip', () => ({ default: () => null }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./components/WorkspaceOpenErrorPage', () => ({ default: () => null }))
vi.mock('./features/notifications/WorkspaceNotificationsMenu', () => ({ WorkspaceNotificationsMenu: () => null }))

import GadgetEditor from './GadgetEditor'

let container: HTMLDivElement
let root: Root
const previousMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
  container.remove()
  if (previousMatchMedia) Object.defineProperty(window, 'matchMedia', previousMatchMedia)
  else Reflect.deleteProperty(window, 'matchMedia')
})

it('follows the divider from the editor edge and leaves the gadget its minimum width', async () => {
  await act(async () => { root.render(<GadgetEditor />) })
  const handle = container.querySelector<HTMLElement>('.cursor-col-resize')!
  const chat = handle.previousElementSibling as HTMLElement
  // The window is jsdom's 1024px; the editor starts after the 68px rail and the card's border.
  const editor = { left: 69, width: 946 }
  vi.spyOn(handle.parentElement!, 'getBoundingClientRect').mockImplementation(() => ({ ...editor }) as DOMRect)
  Object.assign(handle, { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} })
  const drag = (type: string, clientX: number) =>
    act(() => { handle.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX })) })

  drag('pointerdown', 69 + 420)
  drag('pointermove', 69 + 500)
  expect(chat.style.width).toBe('500px')
  drag('pointerup', 69 + 900)
  expect([chat.style.width, localStorage.getItem('gadgets:workshop:chatWidth')]).toEqual(['546px', '546'])

  editor.width = 800
  act(() => { window.dispatchEvent(new Event('resize')) })
  expect(chat.style.width).toBe('400px')
})

it('fits a width saved in a wider window to the editor once it opens', async () => {
  localStorage.setItem('gadgets:workshop:chatWidth', '800')
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 69, width: 946 } as DOMRect)
  await act(async () => { root.render(<GadgetEditor />) })
  const chat = container.querySelector<HTMLElement>('.cursor-col-resize')!.previousElementSibling as HTMLElement
  expect(chat.style.width).toBe(`${946 - 400}px`)
})
