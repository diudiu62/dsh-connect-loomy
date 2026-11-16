/**
 * Card styles, injected once into `<head>`.
 *
 * The family convention (workbuddy / web-search) is inline CSS in the client
 * bundle, deduplicated by a `data-plugin-css` tag id. Only `--dsw-*` design
 * tokens are used, with a neutral fallback so the card still reads correctly in
 * a host that has not loaded the token sheet yet.
 *
 * @module dsh-connect-loomy/client/styles
 */

/** Stable tag id; changing it re-injects the sheet after an upgrade. */
const STYLE_TAG_ID = 'dsh-connect-loomy/card.css'

/** Card CSS. Kept as a plain string so the bundle needs no CSS-module runtime. */
export const CARD_CSS = `
.loomy-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 13px;
  line-height: 1.55;
}
.loomy-header { display: flex; flex-direction: column; gap: 4px; }
.loomy-title { font-size: 15px; font-weight: 600; }
.loomy-subtitle { color: var(--dsw-alias-label-tertiary, #6b7280); }
/* Account list: one compact line per account (identity · route · badges · action). */
.loomy-acct-list { display: flex; flex-direction: column; gap: 2px; }
.loomy-acct-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  min-width: 0;
  padding: 4px 6px;
  border-radius: 7px;
  font-size: 12px;
  line-height: 1.6;
}
.loomy-acct-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.08)); }
/* The identity gets the free space and truncates only when truly cramped; the
   route badge and the action keep their natural width so a row stays a row. */
.loomy-acct-identity {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 40%;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Buttons in a row must not inherit a block-level width from the host panel. */
.loomy-acct-row .loomy-button { flex: 0 0 auto; width: auto; }
.loomy-row-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}
.loomy-add { display: flex; flex-direction: column; gap: 6px; }
.loomy-add-row {
  margin-top: 2px;
  border-top: 1px dashed var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.12));
  border-radius: 0;
  padding-top: 8px;
}
.loomy-add-body { margin-left: 6px; }

/* Account rows (multi-account): one row per provider route. */
.loomy-accounts { display: flex; flex-direction: column; gap: 10px; }
.loomy-account-rows { display: flex; flex-direction: column; gap: 8px; }
.loomy-account-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.12));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.08));
}
.loomy-account-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.loomy-account-identity { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.loomy-account-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
.loomy-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.1));
}

/* SMS login form (account tab). Inputs mirror the host's settings fields. */
.loomy-login { display: flex; flex-direction: column; gap: 10px; }
.loomy-login-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.loomy-input {
  flex: 1 1 140px;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.14));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 13px;
}
.loomy-input:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary, #2563eb);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563eb) 22%, transparent);
}
.loomy-input:disabled { opacity: 0.55; cursor: not-allowed; }
.loomy-textarea {
  flex: 1 1 auto;
  height: auto;
  min-height: 72px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.45;
  resize: vertical;
}

/* Composer credit readout (conversation.input.right), sitting just before the
   model picker. Deliberately tiny and shrinkable: the model name must keep its
   room, so the badge gives way (ellipsis) rather than pushing it out. */
.loomy-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 104px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.12));
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #4b5563);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.loomy-pill:hover { background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.12)); }
.loomy-pill-busy { opacity: 0.6; cursor: progress; }
.loomy-tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.12));
  border-radius: 8px;
  align-self: flex-start;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.08));
}
.loomy-tab {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #4b5563);
  font: inherit;
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.loomy-tab:hover { color: var(--dsw-alias-label-primary, #1f2328); }
.loomy-tab[aria-selected="true"] {
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
}
.loomy-panel { display: flex; flex-direction: column; gap: 14px; }
.loomy-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.12));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.loomy-section-title { font-weight: 600; font-size: 13px; }
.loomy-muted { color: var(--dsw-alias-label-tertiary, #6b7280); }
.loomy-warning { color: var(--dsw-alias-label-primary-dimmed, #b45309); }
.loomy-error { color: var(--dsw-alias-state-error-primary, #b91c1c); }
.loomy-row {
  display: grid;
  grid-template-columns: minmax(96px, max-content) 1fr;
  gap: 4px 12px;
  align-items: baseline;
}
.loomy-label { color: var(--dsw-alias-label-tertiary, #6b7280); }
.loomy-value { min-width: 0; overflow-wrap: anywhere; }
.loomy-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.loomy-toolbar-spacer { flex: 1; }
.loomy-button {
  appearance: none;
  font: inherit;
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.18));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, #1f2328);
  cursor: pointer;
}
.loomy-button:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3, rgba(15, 23, 42, 0.3)); }
.loomy-button:focus-visible,
.loomy-tab:focus-visible,
.loomy-check:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, #2563eb);
  outline-offset: 1px;
}
.loomy-button:disabled { opacity: 0.55; cursor: default; }
.loomy-button-primary {
  background: var(--dsw-alias-state-business-primary, #2563eb);
  border-color: var(--dsw-alias-state-business-primary, #2563eb);
  color: var(--dsw-alias-label-primary-inverted, #fff);
}
.loomy-button-ghost { background: transparent; }
.loomy-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.14));
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1));
  font-size: 12px;
  white-space: nowrap;
}
.loomy-badge-ok { color: var(--dsw-alias-state-success-primary, #15803d); }
.loomy-badge-danger { color: var(--dsw-alias-state-error-primary, #b91c1c); }
.loomy-models { display: flex; flex-direction: column; gap: 4px; }
.loomy-model {
  display: grid;
  grid-template-columns: 24px minmax(0, 1.5fr) max-content max-content max-content max-content minmax(120px, 1fr);
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  border-radius: 8px;
}
.loomy-model:hover { background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1)); }
.loomy-model-head {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.1));
  border-radius: 0;
}
.loomy-model-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.loomy-model-name-text { font-weight: 500; overflow-wrap: anywhere; }
.loomy-model-id { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); }
.loomy-check { width: 15px; height: 15px; accent-color: var(--dsw-alias-state-business-primary, #2563eb); }
.loomy-pre {
  margin: 0;
  padding: 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1));
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow: auto;
}
.loomy-steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
.loomy-notice {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.12));
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1));
}
.loomy-notice-error {
  border-color: var(--dsw-alias-state-error-primary, #b91c1c);
  color: var(--dsw-alias-state-error-primary, #b91c1c);
}
.loomy-credits { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
.loomy-credit-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1));
}
.loomy-credit-value { font-size: 16px; font-weight: 600; }
.loomy-records { display: flex; flex-direction: column; gap: 2px; }
.loomy-record {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content max-content;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.1));
}
.loomy-record:last-child { border-bottom: 0; }
.loomy-record-positive { color: var(--dsw-alias-state-success-primary, #15803d); }
.loomy-record-negative { color: var(--dsw-alias-state-error-primary, #b91c1c); }
.loomy-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
`

/**
 * Inject the stylesheet once per document. Safe to call during render: it is
 * idempotent and a no-op outside a DOM (SSR, tests without jsdom).
 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`)
  if (existing !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-connect-loomy'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CARD_CSS
  document.head.appendChild(tag)
}
