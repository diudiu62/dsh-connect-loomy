/**
 * `VendorDeps` assembly, shared by the registry and the CLI.
 *
 * The same construction in two places is how "works in DSH but not in
 * `doctor`" bugs start, so there is exactly one builder.
 *
 * @module dsh-connect-desktop/core/deps
 */

import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { Logger, VendorDeps, VendorDescriptor } from '../vendor-sdk/contracts.js'
import { createDocument, vendorStorageDir } from './store.js'

export interface DepsInput {
  descriptor: VendorDescriptor
  /** The vendor's resolved config slice (defaults already merged). */
  config: () => Record<string, unknown>
  logger: Logger
  storageDir?: string
  attachments?: () => AttachmentStore | undefined
  imageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  modelsUpdated?: () => void
  now?: () => number
}

export function createVendorDeps(input: DepsInput): VendorDeps {
  const storageDir = input.storageDir ?? vendorStorageDir(input.descriptor.id)
  const now = input.now ?? (() => Date.now())
  return {
    descriptor: input.descriptor,
    config: input.config(),
    setting: <T>(key: string): T => input.config()[key] as T,
    storageDir,
    document: (name, options) => createDocument({ path: `${storageDir}/${name}`, now, ...options }),
    logger: input.logger,
    now,
    attachments: input.attachments ?? (() => undefined),
    imageAccess: input.imageAccess ?? (() => undefined),
    modelsUpdated: input.modelsUpdated ?? (() => undefined),
  }
}
