// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi, ConnectedAccountsFilter, ConnectedAccountsSubscriber, GatekeeperVendorInfo,
} from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import ResourcePicker from './ResourcePicker'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => ({
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

  // Renders the picker over one vendor, with each of `accounts` connected to it.
  const renderPicker = async (
    vendor: GatekeeperVendorInfo,
    searchText: string,
    { accounts = [], onSelectAccount = () => {} }: { accounts?: AccountDescription[]; onSelectAccount?: () => void } = {},
  ) => {
    const authenticatedApi = {
      subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
        for (const [i, account] of accounts.entries()) {
          subscriber.add(i + 1, account, vendor.description, vendor.supportedResources, true, vendor.id)
        }
        subscriber.ready()
        return Object.assign(Promise.resolve(), { [Symbol.dispose]: () => {} })
      },
      listGatekeeperVendors: async () => [vendor],
    } as unknown as RpcStub<AuthenticatedApi>
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ResourcePicker authenticatedApi={authenticatedApi} searchText={searchText} onSelectAccount={onSelectAccount} />,
    ))
    return container
  }

  it('names the placeholder still blocking an account, rather than offering to grant access', async () => {
    const thread: SupportedResource = {
      urlPattern: 'https://chat.google.com/:kind(room|dm)/:spaceId/:threadId{/:messageId}?',
      title: 'Google Chat Thread',
      description: 'One thread',
      grantable: true,
    }
    const vendor = { id: 'google', description: { displayName: 'Google', url: 'https://google.com' }, supportedResources: [thread] }
    // An account that hasn't granted this resource type, so it would otherwise need access.
    const account = { displayName: 'dan@example.com', avatar: { url: '' }, grantedResourceUrlPatterns: [] }
    const onSelectAccount = vi.fn<() => void>()

    const picker = await renderPicker(vendor, 'https://chat.google.com/room/AAQANZZTsQ8/:threadId?cls=7', {
      accounts: [account], onSelectAccount,
    })

    const row = [...picker.querySelectorAll('div')].findLast(div => div.textContent?.includes('dan@example.com'))!
    expect(row.textContent).toContain('Fill in :threadId first')
    expect(row.textContent).not.toContain('Grant access')
    act(() => row.click())
    expect(onSelectAccount).not.toHaveBeenCalled()
  })

  it('lists full matches in the order the gatekeeper declared them', async () => {
    // GitLab declares its merge-request pattern before the project pattern that also matches it.
    const resources: SupportedResource[] = [
      { urlPattern: 'https://gitlab.com/:project+/-/merge_requests/:iid{/*}?', title: 'GitLab Merge Request', description: '' },
      { urlPattern: 'https://gitlab.com/:project+', title: 'GitLab Project', description: '' },
    ]
    const vendor = { id: 'gitlab', description: { displayName: 'GitLab', url: 'https://gitlab.com' }, supportedResources: resources }

    const text = (await renderPicker(vendor, 'https://gitlab.com/group/repo/-/merge_requests/12')).textContent!

    expect(text.indexOf('GitLab Merge Request')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('GitLab Merge Request')).toBeLessThan(text.indexOf('GitLab Project'))
  })

  describe('ambient vendors', () => {
    // Like Principle's Website: each person's one account is minted, never signed in to. The
    // backend leaves an account an admin turned on for everyone out of a subscription that does not
    // ask for those accounts.
    const SITE: SupportedResource = { urlPattern: 'https://*.*/*', title: 'Website', description: 'One hostname' }
    const vendor = {
      id: 'site',
      description: { displayName: 'Website', url: 'https://site.example.com/', autoProvisionsAccount: true },
      supportedResources: [SITE],
    }
    const ACCOUNT = { displayName: 'Website', avatar: { url: '' } }

    const renderAmbient = async ({ forced, added }: { forced: boolean, added: boolean }) => {
      let subscriber: ConnectedAccountsSubscriber | null = null
      const provisionAmbientAccount = vi.fn<(vendorId: string) => Promise<void>>(async () => {
        subscriber!.add(4, ACCOUNT, vendor.description, [SITE], true, 'site')
      })
      const connectAccount = vi.fn<() => Promise<never>>(async () => {
        throw new Error('Website has no connect flow.')
      })
      const onSelectAccount = vi.fn<(accountId: number) => void>()
      const authenticatedApi = {
        subscribeConnectedAccounts: (next: ConnectedAccountsSubscriber, filter?: ConnectedAccountsFilter) => {
          subscriber = next
          if (added && (!forced || filter?.includeForcedAutoProvisionedAccounts)) {
            next.add(4, ACCOUNT, vendor.description, [SITE], true, 'site')
          }
          next.ready()
          return Object.assign(Promise.resolve(), { [Symbol.dispose]: () => {} })
        },
        listGatekeeperVendors: async () => [vendor],
        provisionAmbientAccount,
        connectAccount,
      } as unknown as RpcStub<AuthenticatedApi>
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      await act(async () => root!.render(
        <ResourcePicker
          authenticatedApi={authenticatedApi}
          searchText="https://docs.example.com/guide"
          onSelectAccount={onSelectAccount}
        />,
      ))
      return { picker: container, provisionAmbientAccount, connectAccount, onSelectAccount }
    }

    // The last match is the row's own label: the resource heading above it also reads "Website".
    const row = (picker: HTMLElement, label: string) =>
      [...picker.querySelectorAll<HTMLElement>('span')].findLast(span => span.textContent === label)

    it.each([
      { mode: 'on for everyone', forced: true },
      { mode: 'added by the person', forced: false },
    ])('offers the one Website account when it is $mode, and no other', async ({ forced }) => {
      const { picker, onSelectAccount } = await renderAmbient({ forced, added: true })

      expect(picker.textContent).not.toContain('Connect new account')
      act(() => row(picker, 'Website')!.click())
      expect(onSelectAccount).toHaveBeenCalledWith(4, 'site', SITE, ACCOUNT, vendor.description)
    })

    it('adds the Website account rather than starting a sign-in it does not have', async () => {
      const { picker, provisionAmbientAccount, connectAccount } = await renderAmbient({ forced: false, added: false })

      await act(async () => row(picker, 'Connect new account')!.click())

      expect(provisionAmbientAccount).toHaveBeenCalledExactlyOnceWith('site')
      expect(connectAccount).not.toHaveBeenCalled()
      expect(picker.textContent).not.toContain('Connect new account')
    })
  })
})
