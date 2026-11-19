/**
 * The community entry in the settings card's top-right corner.
 *
 * It sits in the header (not a footer) so it is visible without scrolling, and
 * it renders in every state — including "the host exposed no routes" and "the
 * status read failed", which are the two moments a user needs a channel. It also
 * has to stay honest: an unfilled placeholder must never render as a group
 * number, neither as text nor inside the tooltip.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STATUS, defaultRoutes, installFetch, mountPlugin, renderCard, setupDom } from './helpers.mjs'
import { ISSUES_URL } from '../../lib/index.js'

const STATUS_URL = '/plugins/dsh-connect-loomy/status'

