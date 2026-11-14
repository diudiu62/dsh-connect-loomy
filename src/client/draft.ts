/**
 * Model-selection draft state machine.
 *
 * The card keeps one draft for its whole mounted lifetime, so switching between
 * the account / models / diagnostics tabs cannot drop it. The semantics the
 * acceptance criteria pin down:
 *
 * - a checkbox toggle edits the **draft** only;
 * - a catalog refresh may move the **saved baseline** (the host persisted the
 *   new catalog and, with it, the selection) but must never overwrite a dirty
 *   draft;
 * - Save commits the draft after the host acknowledged it;
 * - Discard restores the draft from the saved baseline.
 *
 * All functions are pure and return new objects, which lets the jsdom tests
 * exercise the transitions without a host.
 *
 * @module dsh-connect-loomy/client/draft
 */

import { uniqueIds } from './api.js'

/** Saved selection plus the user's in-progress selection. */
export interface ModelDraft {
  /** Host-confirmed selection. */
  readonly saved: readonly string[]
  /** What the checkboxes currently show. */
  readonly draft: readonly string[]
}

/** Baseline the draft on a host-reported selection. */
export function createDraft(savedIds: readonly string[]): ModelDraft {
  const saved = uniqueIds(savedIds)
  return { saved, draft: [...saved] }
}

function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const left = new Set(a)
  for (const id of b) if (!left.has(id)) return false
  return true
}

/** Whether the draft differs from the saved selection (order-insensitive). */
export function isDirty(state: ModelDraft): boolean {
  return !sameSelection(state.saved, state.draft)
}

/** Toggle one model in the draft. Never touches the saved baseline. */
export function toggleModel(state: ModelDraft, id: string): ModelDraft {
  if (id.length === 0) return state
  if (state.draft.includes(id)) {
    return { saved: state.saved, draft: state.draft.filter((current) => current !== id) }
  }
  return { saved: state.saved, draft: uniqueIds([...state.draft, id]) }
}

/** Restore the checkboxes from the saved baseline. */
export function discardChanges(state: ModelDraft): ModelDraft {
  return { saved: state.saved, draft: [...state.saved] }
}

/** Commit a host-acknowledged selection: both baseline and draft move. */
export function commitSaved(state: ModelDraft, savedIds: readonly string[]): ModelDraft {
  const saved = uniqueIds(savedIds)
  return { saved, draft: [...saved] }
}

/**
 * Update the saved baseline after a catalog refresh:
 * - clean draft follows the new baseline (newly enabled defaults show up);
 * - dirty draft stays exactly as the user left it.
 */
export function applyBaseline(state: ModelDraft, savedIds: readonly string[]): ModelDraft {
  const saved = uniqueIds(savedIds)
  if (isDirty(state)) return { saved, draft: [...state.draft] }
  return { saved, draft: [...saved] }
}

/**
 * Read the saved selection out of a refreshed catalog when the host elected to
 * mark entries with `enabled`. Returns `null` when no entry carries the flag,
 * so the caller can fall back to the `/status` baseline.
 */
export function enabledIdsFromCatalog(
  catalog: ReadonlyArray<{ id: string; enabled?: boolean }>,
): string[] | null {
  let marked = false
  const ids: string[] = []
  for (const model of catalog) {
    if (typeof model.enabled !== 'boolean') continue
    marked = true
    if (model.enabled) ids.push(model.id)
  }
  return marked ? uniqueIds(ids) : null
}
