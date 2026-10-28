// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import ResourcePicker from './ResourcePicker'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const dispose = vi.fn<() => void>()
  const promise = Object.assign(new Promise<T>(next => { resolve = next }), {
    [Symbol.dispose]: dispose,
  })
  return { promise, resolve, dispose }
}

describe('ResourcePicker', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
  })

  it('disposes a pending connected-account subscription on unmount', async () => {
    const pendingSubscription = deferred<{ [Symbol.dispose](): void }>()
    const authenticatedApi = {
      subscribeConnectedAccounts: () => pendingSubscription.promise,
      listGatekeeperVendors: async () => [],
    } as unknown as RpcStub<AuthenticatedApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ResourcePicker
        authenticatedApi={authenticatedApi}
        searchText="https://example.com"
        onSelectAccount={() => {}}
      />,
    ))

    act(() => root!.unmount())
    root = undefined

    expect(pendingSubscription.dispose).toHaveBeenCalledOnce()
  })

  describe('ambient vendors', () => {
    const FILES_RESOURCE = {
      urlPattern: 'https://files.example.com/drop/*',
      title: 'Work files',
      description: 'Files shared with this workspace',
    }
    const filesVendor = { displayName: 'Files', url: 'https://files.example.com/', autoProvisionsAccount: true }

    // A Files-like vendor set to "enabled": its one account is auto-provisioned, and it has no
    // connect flow, so connectAccount() would throw.
    async function renderAmbient(options: { hasAccount: boolean }) {
      const subscribeConnectedAccounts = vi.fn<(subscriber: ConnectedAccountsSubscriber, filter?: unknown) => Promise<object> & Disposable>(subscriber => {
        if (options.hasAccount) {
          subscriber.add(7, { displayName: 'Files', avatar: { url: 'https://files.example.com/avatar' } }, filesVendor, [FILES_RESOURCE], true, 'files')
        }
        subscriber.ready()
        return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
      })
      const provisionAmbientAccount = vi.fn<(vendorId: string) => Promise<void>>(async () => {})
      const connectAccount = vi.fn<() => Promise<never>>(async () => { throw new Error('auto-provisioned; no connect flow') })
      const onSelectAccount = vi.fn<(...args: unknown[]) => void>()
      const authenticatedApi = {
        subscribeConnectedAccounts,
        listGatekeeperVendors: async () => [{
          id: 'files', description: filesVendor, supportedResources: [FILES_RESOURCE],
        }],
        provisionAmbientAccount,
        connectAccount,
      } as unknown as RpcStub<AuthenticatedApi>

      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      await act(async () => root!.render(
        <ResourcePicker
          authenticatedApi={authenticatedApi}
          searchText="https://files.example.com/drop/abc"
          onSelectAccount={onSelectAccount}
        />,
      ))
      return { subscribeConnectedAccounts, provisionAmbientAccount, connectAccount, onSelectAccount }
    }

    it('offers the forced account and no second one', async () => {
      const { subscribeConnectedAccounts, onSelectAccount } = await renderAmbient({ hasAccount: true })

      expect(subscribeConnectedAccounts.mock.calls[0][1]).toEqual({ includeForcedAutoProvisionedAccounts: true })
      expect(container!.textContent).not.toContain('Connect new account')
      act(() => Array.from(container!.querySelectorAll<HTMLElement>('span'))
        .find(span => span.textContent === 'Files')!.click())
      expect(onSelectAccount).toHaveBeenCalledWith(7, 'files', FILES_RESOURCE, { displayName: 'Files', avatar: { url: 'https://files.example.com/avatar' } }, filesVendor)
    })

    it('provisions the account instead of starting a sign-in', async () => {
      const { provisionAmbientAccount, connectAccount } = await renderAmbient({ hasAccount: false })

      await act(async () => Array.from(container!.querySelectorAll<HTMLElement>('span'))
        .find(span => span.textContent === 'Connect new account')!.click())

      expect(provisionAmbientAccount).toHaveBeenCalledWith('files')
      expect(connectAccount).not.toHaveBeenCalled()
    })
  })
})
