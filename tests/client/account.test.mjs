/**
 * Account tab: masked sign-in state, credential conclusion, executable next
 * steps when signed out, re-check, and a truthful read-only credits overview.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CREDITS,
  STATUS,
  button,
  click,
  defaultRoutes,
  installFetch,
  mountPlugin,
  renderCard,
  setupDom,
} from './helpers.mjs'

const STATUS_URL = '/plugins/dsh-connect-loomy/status'
const CREDITS_URL = '/plugins/dsh-connect-loomy/credits'
const ACCOUNTS_URL = '/plugins/dsh-connect-loomy/accounts'

test('the card never renders the session, even from a hostile payload', async () => {
  await setupDom()
  const { entry, t } = mountPlugin()
  // STATUS carries extra `session`, full `phone` and `userId` fields on purpose:
  // a buggy host must still not leak them through this card.
  installFetch(
    defaultRoutes({
      [STATUS_URL]: {
        body: {
          ...STATUS,
          account: { ...STATUS.account, userId: 'userid-secret-42' },
        },
      },
    }),
  )

  await renderCard(entry, t, ({ container }) => {
    const text = container.textContent
    assert.ok(!text.includes('deadbeefdeadbeefdeadbeefdeadbeef'), 'no session hex')
  })
})

