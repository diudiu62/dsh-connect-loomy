/**
 * The one credential reader.
 *
 * Both vendors do the same thing: walk an ordered candidate list, read the first
 * file that parses, remember how long that answer is good for, and report
 * **where it looked** when nothing parsed. Only `parse` is protocol-specific.
 *
 * Rules this module enforces so a vendor cannot get them wrong:
 *
 * - a credential is read **only** from disk, never written, never refreshed;
 * - a failed read is never cached;
 * - `invalidate()` is what makes a login/logout/re-detect immediate;
 * - the material never appears in a view or a candidate record.
 *
 * @module dsh-connect-desktop/core/credential
 */

import { readFile } from 'node:fs/promises'
import type {
  CredentialCandidate,
  CredentialDriver,
  CredentialIdentity,
  CredentialOrigin,
  CredentialState,
} from '../vendor-sdk/contracts.js'

/** One file the vendor will inspect. */
export interface CredentialFile {
  path: string
  origin: CredentialOrigin
}

/** What a parsed credential file yields. */
export interface ParsedCredential {
  material: string
  identity?: CredentialIdentity
  expiresAt?: number
  /** Set when the file is present but unusable (e.g. "令牌已过期"). */
  problem?: string
}

export interface CredentialDriverOptions {
  /** The ordered candidate list. Built from the environment on every read. */
  files: (context: { discovered: readonly CredentialFile[] }) => readonly CredentialFile[]
  /** Read window; `0` re-reads every time. */
  ttlMs: () => number
  /** Parse one file. Return `{problem}` when it is present but unusable. */
  parse: (text: string, file: CredentialFile) => ParsedCredential
  /** Optional bounded fallback search, run only while signed out. */
  discover?: () => Promise<readonly CredentialFile[]>
  now?: () => number
}

export interface CredentialDriverFull extends CredentialDriver {
  /** Epoch ms of the credential's expiry, when the vendor can parse one. */
  expiresAt(): number | undefined
  /** True when the last read found an expired credential. */
  expired(): boolean
  /** Force one read and report candidates; used by 「重新检测」 and diagnostics. */
  probe(): Promise<{ state: CredentialState; candidates: CredentialCandidate[] }>
}

const SIGNED_OUT: readonly CredentialFile[] = []

export function createCredentialDriver(options: CredentialDriverOptions): CredentialDriverFull {
  const now = options.now ?? (() => Date.now())
  let state: CredentialState | undefined
  let readAt = 0
  let discovered: readonly CredentialFile[] = SIGNED_OUT

  const inspect = async (file: CredentialFile): Promise<{ candidate: CredentialCandidate; parsed?: ParsedCredential }> => {
    let text: string
    try {
      text = await readFile(file.path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return {
        candidate: {
          path: file.path,
          exists: code !== 'ENOENT',
          state: code === 'ENOENT' ? 'missing' : 'unreadable',
          reason: code === 'ENOENT' ? '文件不存在' : `无法读取：${code ?? 'unknown'}`,
        },
      }
    }
    try {
      const parsed = options.parse(text, file)
      if (parsed.material.length === 0) {
        return { candidate: { path: file.path, exists: true, state: 'invalid_shape', reason: '解析结果为空' } }
      }
      return {
        candidate: { path: file.path, exists: true, state: 'ok', reason: '已读取' },
        parsed,
      }
    } catch (error) {
      return {
        candidate: {
          path: file.path,
          exists: true,
          state: 'invalid_json',
          reason: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  const readAll = async (): Promise<CredentialState> => {
    const files = options.files({ discovered })
    const candidates: CredentialCandidate[] = []
    let expiredHit: { file: CredentialFile; parsed: ParsedCredential } | undefined
    for (const file of files) {
      const { candidate, parsed } = await inspect(file)
      candidates.push(candidate)
      if (parsed === undefined) continue
      if (parsed.problem !== undefined) {
        candidates[candidates.length - 1] = {
          path: file.path,
          exists: true,
          state: 'invalid_shape',
          reason: parsed.problem,
        }
        continue
      }
      const isExpired = parsed.expiresAt !== undefined && parsed.expiresAt <= now()
      if (isExpired) {
        // Keep looking: a second file may still be valid (desktop re-login).
        expiredHit ??= { file, parsed }
        candidates[candidates.length - 1] = {
          path: file.path,
          exists: true,
          state: 'expired',
          reason: `已过期（${new Date(parsed.expiresAt as number).toISOString()}）`,
        }
        continue
      }
      return {
        found: true,
        material: parsed.material,
        sourcePath: file.path,
        sourceOrigin: file.origin,
        candidates,
        ...(parsed.identity === undefined ? {} : { identity: parsed.identity }),
        ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }),
      }
    }
    if (expiredHit !== undefined) {
      return {
        found: true,
        material: expiredHit.parsed.material,
        sourcePath: expiredHit.file.path,
        sourceOrigin: expiredHit.file.origin,
        expired: true,
        candidates,
        ...(expiredHit.parsed.identity === undefined ? {} : { identity: expiredHit.parsed.identity }),
        ...(expiredHit.parsed.expiresAt === undefined ? {} : { expiresAt: expiredHit.parsed.expiresAt }),
      }
    }
    return {
      found: false,
      problem: signedOutProblem(candidates),
      candidates,
    }
  }

  const engine: CredentialDriverFull = {
    async read(readOptions = {}) {
      const ttl = options.ttlMs()
      if (readOptions.force !== true && state !== undefined && Date.now() - readAt < ttl) return state
      let next = await readAll()
      // The bounded fallback search runs only while signed out, and only once
      // per invalidation: its result is folded into the candidate list.
      if (!next.found && options.discover !== undefined) {
        try {
          discovered = await options.discover()
        } catch {
          discovered = SIGNED_OUT
        }
        if (discovered.length > 0) next = await readAll()
      }
      state = next
      readAt = Date.now()
      return next
    },

    invalidate() {
      state = undefined
      readAt = 0
      discovered = SIGNED_OUT
    },

    probePaths() {
      return options.files({ discovered }).map((file) => file.path)
    },

    expiresAt() {
      return state?.found === true ? state.expiresAt : undefined
    },

    expired() {
      return state?.found === true && state.expired === true
    },

    async probe() {
      engine.invalidate()
      const next = await engine.read({ force: true })
      return { state: next, candidates: next.candidates as CredentialCandidate[] }
    },
  }

  return engine
}

/** An actionable sentence when every candidate failed, naming the first path. */
function signedOutProblem(candidates: readonly CredentialCandidate[]): string {
  if (candidates.length === 0) return '没有可读取的登录态路径。'
  const first = candidates[0] as CredentialCandidate
  const expired = candidates.find((candidate) => candidate.state === 'expired')
  if (expired !== undefined) return `登录态已过期（${expired.path}），请在桌面端重新登录后点「重新检测」。`
  return `未找到登录态：${first.path}。请先在该桌面客户端登录，然后点「重新检测」。`
}
