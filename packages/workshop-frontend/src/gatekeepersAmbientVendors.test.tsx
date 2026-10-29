// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'

const state = vi.hoisted(() => ({ api: null as RpcStub<AuthenticatedApi> | null }))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: state.api }) }))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Cloudflare OS' }))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: () => {} }),
}))
import { Route } from './routes/gatekeepers'
const GatekeepersPage = Route.options.component!
await GatekeepersPage.preload?.()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  state.api = null
  localStorage.clear()
  vi.unstubAllGlobals()
})

// A vendor that is both a resource gatekeeper (listGatekeeperVendors) and ambient
// (autoProvisionsAccount), the shape of an optional ambient connection with browsable resources.
const description = { displayName: 'Ambient Docs', url: 'https://docs.example', tagline: 'Ambient service', autoProvisionsAccount: true }
const resourceVendor: GatekeeperVendorInfo = {
  id: 'ambient-docs', description,
  supportedResources: [{ title: 'Folder', urlPattern: 'https://docs.example/*', description: 'A folder of documents' }],
} as unknown as GatekeeperVendorInfo
const addableVendor = { id: 'ambient-docs', description, supportedResources: [] } as unknown as GatekeeperVendorInfo

const renderPage = async ({ addable, connected }: { addable: GatekeeperVendorInfo[], connected: boolean }) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  state.api = {
    listAddableGatekeepers: async () => addable,
    listGatekeeperVendors: async () => [resourceVendor],
    subscribeConnectedAccounts: (subscriber: Parameters<AuthenticatedApi['subscribeConnectedAccounts']>[0]) => {
      if (connected) subscriber.add(1, { displayName: 'alice@example.com' } as never, description as never, [], true, 'ambient-docs')
      subscriber.ready()
      return Object.assign(Promise.resolve(), { [Symbol.dispose]() {} })
    },
    onRpcBroken: () => {},
  } as unknown as RpcStub<AuthenticatedApi>
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<GatekeepersPage />))
}
const cards = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="button"]'))
  .filter(element => element.textContent?.includes('Ambient Docs'))

describe('an ambient resource vendor on the Gatekeepers page', () => {
  it('is offered once when the ambient policy lets the user add it', async () => {
    await renderPage({ addable: [addableVendor], connected: false })
    expect(cards()).toHaveLength(1)
  })

  it('shows once, as connected, when the person has already added the optional account', async () => {
    await renderPage({ addable: [], connected: true })
    expect(cards()).toHaveLength(1)
    expect(cards()[0].textContent).toContain('alice@example.com')
  })
})
