/**
 * Models tab: catalog facts, per-model checkboxes, and the draft contract —
 * refresh never overwrites unsaved checks, only Save applies them, Discard
 * restores the host-confirmed selection.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CATALOG,
  STATUS,
  button,
  buttonsByText,
  click,
  defaultRoutes,
  installFetch,
  modelCheckboxes,
  mountPlugin,
  renderCard,
  setupDom,
  tab,
} from './helpers.mjs'

const REFRESH_URL = '/plugins/dsh-connect-loomy/refresh'
const SAVE_URL = '/plugins/dsh-connect-loomy/save'
const STATUS_URL = '/plugins/dsh-connect-loomy/status'

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function openModels(container) {
  await click(tab(container, '模型'))
}

