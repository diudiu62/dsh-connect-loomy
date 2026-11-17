/**
 * Community contacts: single source, placeholder hygiene.
 *
 * The card, `--help` and the READMEs all quote `shared/community.ts`. What must
 * not happen is an unfilled `[QQ_GROUP]` reaching the UI as if it were a real
 * group number, so the filter is tested directly here.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMMUNITY,
  DISCUSSIONS_URL,
  ISSUES_URL,
  REPOSITORY_URL,
  communityChannels,
  communityHref,
  isPlaceholder,
} from '../../lib/index.js'

test('the GitHub channels are derived from the repository url', () => {
  assert.equal(REPOSITORY_URL, 'https://github.com/diudiu62/dsh-connect-loomy')
  assert.equal(ISSUES_URL, `${REPOSITORY_URL}/issues`)
  assert.equal(DISCUSSIONS_URL, `${REPOSITORY_URL}/discussions`)
  assert.equal(COMMUNITY.issues, ISSUES_URL)
  assert.equal(COMMUNITY.discussions, DISCUSSIONS_URL)
})

test('placeholders are recognised, real values are not', () => {
  assert.equal(isPlaceholder('[QQ_GROUP]'), true)
  assert.equal(isPlaceholder('  [WECHAT_ID]  '), true)
  assert.equal(isPlaceholder(''), true)
  assert.equal(isPlaceholder('   '), true)
  assert.equal(isPlaceholder('123456789'), false)
  assert.equal(isPlaceholder('https://example.com/group'), false)
  // The GitHub links must never be mistaken for placeholders.
  assert.equal(isPlaceholder(ISSUES_URL), false)
})

test('only usable contacts are rendered, in declaration order', () => {
  // Shipped table: the unfilled slots are hidden, so the card cannot invite
  // users to a group nobody can join.
  assert.deepEqual(communityChannels(), ['issues', 'discussions'])
  // Filling a slot is enough — no component or dictionary change.
  assert.deepEqual(communityChannels({ ...COMMUNITY, qqGroup: '123456789' }), [
    'issues',
    'discussions',
    'qqGroup',
  ])
  assert.deepEqual(communityChannels({ ...COMMUNITY, email: 'dev@example.com' }), [
    'issues',
    'discussions',
    'email',
  ])
  // An explicitly blanked link is dropped too (a release could disable one).
  assert.deepEqual(communityChannels({ ...COMMUNITY, discussions: ' ' }), ['issues'])
})

test('hrefs: GitHub stays a url, the mailbox becomes mailto, chat stays text', () => {
  assert.equal(communityHref('issues', ISSUES_URL), ISSUES_URL)
  assert.equal(communityHref('discussions', DISCUSSIONS_URL), DISCUSSIONS_URL)
  assert.equal(communityHref('email', ' dev@example.com '), 'mailto:dev@example.com')
  // No stable join URL can be derived from a QQ group number.
  assert.equal(communityHref('qqGroup', '123456789'), undefined)
  assert.equal(communityHref('wechat', 'loomy-dev'), undefined)
})
