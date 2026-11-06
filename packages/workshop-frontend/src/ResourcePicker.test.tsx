// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
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
    { accounts = [], accountResources, onSelectAccount = () => {}, onItems, onRefine, activateRef }: {
      accounts?: AccountDescription[]
      accountResources?: SupportedResource[][]
      onSelectAccount?: () => void
      onItems?: ComponentProps<typeof ResourcePicker>['onItems']
      onRefine?: ComponentProps<typeof ResourcePicker>['onRefine']
      activateRef?: ComponentProps<typeof ResourcePicker>['activateRef']
    } = {},
  ) => {
    const authenticatedApi = {
      subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
        for (const [i, account] of accounts.entries()) {
          subscriber.add(i + 1, account, vendor.description,
            accountResources?.[i] ?? vendor.supportedResources, true, vendor.id)
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
      <ResourcePicker authenticatedApi={authenticatedApi} searchText={searchText} onSelectAccount={onSelectAccount} onItems={onItems} onRefine={onRefine} activateRef={activateRef} />,
    ))
    return container
  }

  it.each(['', 'Environment', 'https://example.com/environments/123', 'https://example.com/environments/'])(
    'excludes creation-only resources from account, connection and refinement choices for %j', async searchText => {
      const resource: SupportedResource = {
        urlPattern: 'https://example.com/environments/:id', title: 'Environment', description: '',
        connectable: false, creatable: true,
      }
      const vendor = { id: 'example', description: { displayName: 'Example', url: 'https://example.com' }, supportedResources: [resource] }
      const onItems = vi.fn<NonNullable<ComponentProps<typeof ResourcePicker>['onItems']>>()
      const picker = await renderPicker(vendor, searchText, {
        accounts: [{ displayName: 'alice', avatar: { url: '' } }], onItems, onRefine: () => {},
      })

      expect(picker.textContent).toContain('No matching resources.')
      expect(onItems).toHaveBeenLastCalledWith([])
    },
  )

  it.each(['', 'Environment', 'https://example.com/environments/123'])(
    'offers only accounts supporting connection to the matched type for %j', async searchText => {
      const resource: SupportedResource = {
        urlPattern: 'https://example.com/environments/:id', title: 'Environment', description: '',
      }
      const vendor = { id: 'example', description: { displayName: 'Example', url: 'https://example.com' }, supportedResources: [resource] }
      const accounts = ['creation-only', 'unavailable-type', 'connectable']
        .map(displayName => ({ displayName, avatar: { url: '' } }))
      const onItems = vi.fn<NonNullable<ComponentProps<typeof ResourcePicker>['onItems']>>()
      const onSelectAccount = vi.fn<() => void>()
      const activateRef = { current: null } as NonNullable<ComponentProps<typeof ResourcePicker>['activateRef']>
      const picker = await renderPicker(vendor, searchText, {
        accounts,
        accountResources: [[{ ...resource, connectable: false, creatable: true }], [], [resource]],
        onItems, onSelectAccount, activateRef,
      })

      expect(onItems.mock.lastCall?.[0].filter(item => item.type === 'account')
        .map(item => item.accountId)).toEqual([3])
      expect(picker.textContent).not.toContain('creation-only')
      expect(picker.textContent).not.toContain('unavailable-type')
      expect(picker.textContent).toContain('connectable')

      act(() => activateRef.current!(0))
      const row = [...picker.querySelectorAll('div')]
        .findLast(div => div.textContent?.includes('connectable'))!
      act(() => row.click())
      expect(onSelectAccount).toHaveBeenCalledTimes(2)
      expect(onSelectAccount).toHaveBeenLastCalledWith(3, vendor.id, resource, accounts[2], vendor.description)
    },
  )

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

    // `held` keeps the subscription from replaying until the test calls `replay()`, as the backend
    // does while it is still minting the account it will replay.
    const renderAmbient = async ({ forced, added, held = false }: { forced: boolean, added: boolean, held?: boolean }) => {
      let subscriber: ConnectedAccountsSubscriber | null = null
      let includesForced = false
      const replay = () => {
        if (added && (!forced || includesForced)) {
          subscriber!.add(4, ACCOUNT, vendor.description, [SITE], true, 'site')
        }
        subscriber!.ready()
      }
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
          includesForced = filter?.includeForcedAutoProvisionedAccounts === true
          if (!held) replay()
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
      return { picker: container, provisionAmbientAccount, connectAccount, onSelectAccount, replay }
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

    // While the subscription has not called ready(), the backend may still be minting the account
    // it is about to replay; a Connect pressed then would mint a second.
    it('holds Connect until the accounts subscription is ready', async () => {
      const { picker } = await renderAmbient({ forced: true, added: true, held: true })

      expect(picker.textContent).toContain('Loading connections…')
      expect(picker.textContent).not.toContain('Connect new account')
    })

    it('offers no Connect once the subscription replays the Website account', async () => {
      const { picker, replay, onSelectAccount } = await renderAmbient({ forced: true, added: true, held: true })

      await act(async () => replay())

      expect(picker.textContent).not.toContain('Connect new account')
      act(() => row(picker, 'Website')!.click())
      expect(onSelectAccount).toHaveBeenCalledWith(4, 'site', SITE, ACCOUNT, vendor.description)
    })

    it('offers Connect once ready with no Website account, and adds it once', async () => {
      // The automatic pass failed, so the subscription is ready with nothing to replay.
      const { picker, replay, provisionAmbientAccount, connectAccount } =
        await renderAmbient({ forced: true, added: false, held: true })

      await act(async () => replay())
      await act(async () => row(picker, 'Connect new account')!.click())

      expect(provisionAmbientAccount).toHaveBeenCalledExactlyOnceWith('site')
      expect(connectAccount).not.toHaveBeenCalled()
    })
  })
})
