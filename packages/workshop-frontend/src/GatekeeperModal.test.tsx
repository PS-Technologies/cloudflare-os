// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi, ConnectedAccountsSubscriber, ModelKind } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
  readinessEvents: [] as (boolean | null)[],
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('./ResourceConfiguratorHost', async () => {
  const { useEffect } = await import('react')

  const ResourceConfiguratorHost = ({
    frame,
    loading,
    disabled,
    onCollectResourceUrlChange,
    onSelectionReadyChange,
  }: {
    frame: object | null
    loading: boolean
    disabled: boolean
    onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange?: (ready: boolean | null) => void
  }) => {
    const mounted = Boolean(frame && !loading && !disabled)
    useEffect(() => {
      if (!mounted) return
      onCollectResourceUrlChange?.(() => Promise.resolve('https://catalog.example.com/'))
      testState.readinessEvents.push(null)
      onSelectionReadyChange?.(null)
      return () => onCollectResourceUrlChange?.(null)
    }, [mounted, onCollectResourceUrlChange, onSelectionReadyChange])
    return mounted ? <div data-testid="resource-configurator" /> : null
  }

  return { default: ResourceConfiguratorHost }
})

import GatekeeperModal from './GatekeeperModal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RESOURCE = {
  urlPattern: 'https://catalog.example.com/*',
  title: 'Service catalog',
  description: 'Example service catalog',
}

function subscription() {
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
    [Symbol.dispose]() {},
  })
}

const CHAT_MODEL: AiChatAuthorInfo = { type: 'agent', id: 'chat-model', name: 'Chat model' }
const DECISION_MODEL: AiChatAuthorInfo = { type: 'agent', id: 'decision-model', name: 'Decision model' }

function authenticatedApi(): RpcStub<AuthenticatedApi> {
  const vendor = { displayName: 'Service catalog', url: 'https://catalog.example.com/' }
  return {
    listModels: async (kind?: ModelKind) => kind === 'decision' ? [DECISION_MODEL] : [CHAT_MODEL],
    listGatekeeperVendors: async () => [{
      id: 'catalog',
      description: vendor,
      supportedResources: [RESOURCE],
    }],
    subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
      subscriber.add(1, {
        displayName: 'Catalog account',
        avatar: { url: 'https://catalog.example.com/avatar' },
      }, vendor, [RESOURCE], true, 'catalog')
      subscriber.ready()
      return subscription()
    },
    startResourceConfigurator: async () => ({
      iframeHtml: '<!doctype html>',
      ui: { [Symbol.dispose]() {} },
    }),
  } as unknown as RpcStub<AuthenticatedApi>
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  testState.authenticatedApi = null
  testState.readinessEvents = []
  vi.unstubAllGlobals()
})

async function renderModal(
  props: { initialVendorId?: string, initialResourceUrlPattern?: string } = {},
  api = authenticatedApi(),
) {
  testState.authenticatedApi = api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => root!.render(<GatekeeperModal
    open
    onClose={() => {}}
    getOverseer={() => { throw new Error('not called') }}
    onCreated={() => Promise.resolve()}
    {...props}
  />))
}

describe('GatekeeperModal configurator readiness', () => {
  it('keeps Add connection disabled for a lifecycle null readiness event', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    await renderModal({ initialVendorId: 'catalog', initialResourceUrlPattern: RESOURCE.urlPattern })

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="resource-configurator"]')).not.toBeNull()
      expect(testState.readinessEvents).toEqual([null])
    })

    const addConnection = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'Add connection')!
    expect(addConnection.disabled).toBe(true)
  })
})

describe('GatekeeperModal model pickers', () => {
  // A decision model can back an AI Model binding but can't run an agent. The AI Model picker labels
  // each model with its kind.
  it.each([
    { groupKey: 'platform:ai-model', picker: 'Select an AI model',
      options: ['Language models: Chat model', 'Decision models: Decision model'] },
    { groupKey: 'platform:agent-spawner', picker: 'Agent model', options: ['None (no agent)', 'Chat model'] },
  ])('offers $options in the $groupKey picker', async ({ groupKey, picker, options }) => {
    await renderModal()

    const group = document.body.querySelector<HTMLButtonElement>(
      `[aria-controls="connection-group-panel-${groupKey}"]`)!
    await act(async () => group.click())
    await act(async () => document.getElementById(`connection-group-panel-${groupKey}`)!
      .querySelector('button')!.click())
    await act(async () => document.body.querySelector<HTMLButtonElement>(`[aria-label="${picker}"]`)!.click())

    expect(Array.from(document.body.querySelectorAll('[role="option"]'), option => {
      const heading = option.closest('[role="group"]')?.getAttribute('aria-labelledby')
      return heading ? `${document.getElementById(heading)!.textContent}: ${option.textContent}` : option.textContent
    })).toEqual(options)
  })
})

function buttonLabels() {
  return Array.from(document.body.querySelectorAll('button'), button => button.textContent ?? '')
}

describe('GatekeeperModal ambient vendors', () => {
  const FILES_RESOURCE = {
    urlPattern: 'https://files.example.com/drop/*',
    title: 'Work files',
    description: 'Files shared with this workspace',
  }
  const filesVendor = { displayName: 'Files', url: 'https://files.example.com/', autoProvisionsAccount: true }

  // A Files-like vendor set to "enabled": its one account is auto-provisioned, and it has no
  // connect flow, so connectAccount() would throw.
  function ambientApi(options: { hasAccount: boolean }) {
    const subscribeConnectedAccounts = vi.fn<(subscriber: ConnectedAccountsSubscriber, filter?: unknown) => ReturnType<typeof subscription>>(subscriber => {
      if (options.hasAccount) {
        subscriber.add(7, { displayName: 'Files', avatar: { url: 'https://files.example.com/avatar' } }, filesVendor, [FILES_RESOURCE], true, 'files')
      }
      subscriber.ready()
      return subscription()
    })
    const provisionAmbientAccount = vi.fn<(vendorId: string) => Promise<void>>(async () => {})
    const connectAccount = vi.fn<() => Promise<never>>(async () => { throw new Error('auto-provisioned; no connect flow') })
    const api = {
      ...authenticatedApi(),
      listGatekeeperVendors: async () => [{
        id: 'files',
        description: filesVendor,
        supportedResources: [FILES_RESOURCE],
      }],
      subscribeConnectedAccounts,
      provisionAmbientAccount,
      connectAccount,
    } as unknown as RpcStub<AuthenticatedApi>
    return { api, subscribeConnectedAccounts, provisionAmbientAccount, connectAccount }
  }

  it('shows the forced account and offers no second one', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    const { api, subscribeConnectedAccounts } = ambientApi({ hasAccount: true })
    await renderModal({ initialVendorId: 'files', initialResourceUrlPattern: FILES_RESOURCE.urlPattern }, api)

    expect(subscribeConnectedAccounts.mock.calls[0][1]).toEqual({ includeForcedAutoProvisionedAccounts: true })
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="resource-configurator"]')).not.toBeNull()
    })
    expect(buttonLabels().some(label => label.includes('Use another Files account'))).toBe(false)
    expect(buttonLabels().some(label => label.includes('Connect Files'))).toBe(false)
  })

  it('provisions the account instead of starting a sign-in', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    const { api, provisionAmbientAccount, connectAccount } = ambientApi({ hasAccount: false })
    await renderModal({ initialVendorId: 'files', initialResourceUrlPattern: FILES_RESOURCE.urlPattern }, api)

    const connect = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Connect Files'))!
    await act(async () => connect.click())

    expect(provisionAmbientAccount).toHaveBeenCalledWith('files')
    expect(connectAccount).not.toHaveBeenCalled()
  })
})
