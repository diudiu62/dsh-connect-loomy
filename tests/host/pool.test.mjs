import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAccountPool,
  createAccountsStore,
  createProviderRuntime,
  NO_POINTS_CODE,
  disqualifiesAccount,
  DEFAULT_POOL_COOLDOWN_MS,
  POOL_ROUTE,
} from '../../lib/index.js'

const S = (letter) => letter.repeat(40)

const freshStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'loomy-pool-'))
  return {
    dir,
    store: createAccountsStore({ storageDir: () => dir, now: () => 1_000_000 }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('only failures that mean "skip this account" disqualify it', () => {
  assert.equal(disqualifiesAccount('100002 缺少 token'), true)
  assert.equal(disqualifiesAccount('MissingCredential: session expired'), true)
  assert.equal(disqualifiesAccount('余额不足'), true)
  assert.equal(disqualifiesAccount('rate limit exceeded'), true)
  // A transient transport failure must not bench a healthy account.
  assert.equal(disqualifiesAccount('socket hang up'), false)
  assert.equal(disqualifiesAccount('timed out after 300000ms'), false)
  assert.equal(disqualifiesAccount(undefined), false)
})

