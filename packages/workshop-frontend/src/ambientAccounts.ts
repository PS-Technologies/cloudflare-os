import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsFilter } from '@gadgets/workshop-shared/api'
import type { VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { openConnectWindow } from './connectHandoff'

// An ambient vendor (VendorDescription.autoProvisionsAccount) gives each person one account, which
// the Workshop mints rather than signs in to. These keep a picker that binds an account to a
// resource right about such a vendor, as ObserverConfigModal and the Connections page already are.

/**
 * The accounts a picker subscribes to. A plain subscription leaves out an ambient account the admin
 * turned on for everyone, which suits the Connections page; a picker needs it, since it is the only
 * account its vendor has. Asking for it also mints it for a person who has none yet.
 */
export const PICKER_ACCOUNTS: ConnectedAccountsFilter = { includeForcedAutoProvisionedAccounts: true }

/**
 * Connects an account from a picker. An ambient vendor has no sign-in, so its one account is added
 * instead and arrives through the accounts subscription: resolves `added`. Otherwise resolves as
 * `openConnectWindow` does.
 */
export async function connectOrAddAccount(
  api: RpcStub<AuthenticatedApi>,
  vendorId: string,
  vendor: VendorDescription | undefined,
  resourceUrlPatterns?: string[],
): Promise<'added' | 'opened' | 'connected'> {
  if (vendor?.autoProvisionsAccount) {
    await api.provisionAmbientAccount(vendorId)
    return 'added'
  }
  return openConnectWindow(await api.connectAccount(vendorId, resourceUrlPatterns), api)
}

/** Whether a picker offers to connect another account. An ambient vendor has at most one. */
export function offersAnotherAccount(vendor: VendorDescription | undefined, accounts: number): boolean {
  return accounts === 0 || !vendor?.autoProvisionsAccount
}

/**
 * Whether a picker holds back an ambient vendor's Connect. Until the accounts subscription calls
 * `ready()`, the backend may still be minting the account it is about to replay, and a Connect
 * pressed then would mint a second. ObserverConfigModal waits for `ready()` the same way.
 */
export function holdsConnect(vendor: VendorDescription | undefined, accountsReady: boolean): boolean {
  return !accountsReady && Boolean(vendor?.autoProvisionsAccount)
}
