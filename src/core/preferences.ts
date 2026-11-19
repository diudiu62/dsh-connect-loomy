/**
 * Preferences that live in the vendor's state document, written once.
 *
 * Two facts per vendor, both user choices rather than facts about the accounts:
 * whether automatic rotation is offered, and which account a non-rotating route
 * authenticates as.
 *
 * @module dsh-connect-desktop/core/preferences
 */

import type { DocumentStore } from '../vendor-sdk/contracts.js'
import type { VendorState } from './state.js'

export interface VendorPreferences {
  /** Rotation is ON unless the user turned it off (visible by default). */
  poolEnabled(): Promise<boolean>
  setPoolEnabled(enabled: boolean): Promise<void>
  activeAccountId(): Promise<string | undefined>
  setActiveAccountId(id: string | undefined): Promise<void>
}

export function createVendorPreferences(state: DocumentStore<VendorState>): VendorPreferences {
  return {
    async poolEnabled() {
      return (await state.load()).poolEnabled !== false
    },
    async setPoolEnabled(enabled) {
      const current = await state.load()
      await state.save({ ...current, poolEnabled: enabled })
    },
    async activeAccountId() {
      return (await state.load()).activeAccountId
    },
    async setActiveAccountId(id) {
      const current = await state.load()
      await state.save({ ...current, activeAccountId: id })
    },
  }
}
