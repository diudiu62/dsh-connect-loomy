/**
 * Card styles, injected once into `<head>`.
 *
 * Two rules make this sheet capability-driven rather than vendor-driven:
 *
 * 1. **`dcss-` prefix, no brand in the class names.** The card used to carry a
 *    vendor prefix on every rule, which meant a second vendor either reused the
 *    first one's names (and its accidental overrides) or needed a second sheet.
 * 2. **Brand colour is a variable.** `--dcss-accent` is set on the card root
 *    from `VendorStatusView.accent`, so a new vendor gets its chrome by
 *    declaring an accent, not by editing CSS. Every accent use falls back to the
 *    host's own tokens, so a host without the variable still reads correctly.
 *
 * Only `--dsw-*` design tokens are used besides that, with neutral fallbacks.
 *
 * @module dsh-connect-desktop/client/styles
 */

/** Stable tag id; changing it re-injects the sheet after an upgrade. */
const STYLE_TAG_ID = 'dsh-connect-desktop/card.css'

/** Card CSS. Kept as a plain string so the bundle needs no CSS-module runtime. */
export const CARD_CSS = `
/*
 * 间距节奏 —— 全表只用这四个值，不要再引入其它数字：
 *   L1 块之间   16px   （卡片根、兄弟 Section 之间）
 *   L2 块内段落  8px   （Section / panel / 表单内部）
 *   L3 行内      4px   （按钮与文字、行内元素之间）
 *   L4 列表微距  2px   （账号行、流水行之间）
 * 一个页面里出现五种垂直节奏，用户会觉得"每块都差一点点"却说不清差在哪。
 */
/*
 * 排版上下文：卡片和浮层装的是**同一批面板**，字号/行高/文字色/强调色必须是同一份。
 *
 * 控件（按钮、输入框、表格里的模型名）都用 font:inherit——这是对的，控件应当
 * 跟随所在面板。代价是**容器必须提供那个上下文**：浮层早先只有背景与圆角、
 * 没有字号，于是里面所有按钮/输入框退回浏览器默认 16px，在 13px 的正文旁边
 * 像放大了两号（用户报的"按钮样式不对"）。
 *
 * container-type 也在这里：配置字段的窄屏单列规则走容器查询，容器不存在时
 * 那条规则在浮层里永远不会生效。
 */
.dcss-card,
.dcss-sheet {
  container-type: inline-size;
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 13px;
  line-height: 1.55;
  --dcss-accent: var(--dsw-alias-state-business-primary, #2563eb);
}
.dcss-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
/* Header: text on the left, the community entry pinned to the top-right. */
.dcss-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 16px;
  flex-wrap: wrap;
}
.dcss-header-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dcss-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* Identity summary: one line replacing a four-row fact table. The status bar above
   already says who is signed in; this only adds the facts it cannot (source, since
   when) plus the one action that needs them. */
.dcss-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.dcss-summary-meta {
  font-size: 12px;
  /* 二级灰：三级灰在浅色下只有 3.71，12px 小字达不到 AA。 */
  color: var(--dsw-alias-label-secondary, #4b5563);
  font-variant-numeric: tabular-nums;
}
.dcss-summary-spacer { flex: 1 1 auto; min-width: 4px; }
/* Status bar: answers "which product, which identity" on every tab.
   It exists because switching to 模型/诊断 used to lose that context entirely. */
.dcss-statusbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.06));
  --dcss-accent: var(--dsw-alias-state-business-primary, #2563eb);
}
.dcss-statusbar-vendor {
  font-weight: 600;
  color: var(--dcss-accent);
}
.dcss-statusbar-identity {
  color: var(--dsw-alias-label-secondary, #4b5563);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40ch;
}
.dcss-statusbar-spacer { flex: 1 1 auto; min-width: 4px; }
.dcss-statusbar-metric {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* Vendor switch: a **segmented control**, visually distinct from the tab strip
   below it. The two used to be同一种 pill-in-a-box, which made "which product"
   and "which page" indistinguishable. */
.dcss-vendor-switch {
  display: flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.12));
  border-radius: 9px;
  align-self: flex-start;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.06));
  flex-wrap: wrap;
}
.dcss-vendor-tab {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #4b5563);
  font: inherit;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 7px;
  cursor: pointer;
}
.dcss-vendor-tab-off {
  /* 未登录的那一家仍然可选（用户要进去看原因、点重新检测），只是标记一下。 */
  color: var(--dsw-alias-label-tertiary, #6b7280);
  margin-left: 2px;
}
.dcss-vendor-tab[aria-selected="true"] {
  /* 实心品牌色：一眼看出"当前产品"，与下面下划线式的 tab 形成层级差。 */
  background: var(--dcss-accent);
  color: #fff;
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.18);
}

.dcss-tabs {
  /* 下划线式：给内容让位，也不再和上面的分段控件抢视觉重量。 */
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.12));
}
.dcss-tab {
  appearance: none;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #4b5563);
  font: inherit;
  padding: 6px 12px;
  margin-bottom: -1px;
  cursor: pointer;
}
.dcss-tab:hover { color: var(--dsw-alias-label-primary, #1f2328); }
.dcss-tab[aria-selected="true"] {
  /* 用主文字色 + 品牌色下划线：品牌蓝当 13px 文字时对比度只有 4.23，
     而"选中"这件事已经由下划线表达了。 */
  color: var(--dsw-alias-label-primary, #1f2328);
  font-weight: 600;
  border-bottom-color: var(--dcss-accent);
}
.dcss-panel { display: flex; flex-direction: column; gap: 8px; }
/* tab 面板装的是"块"，用块之间的节奏（16），不是块内段落（8）。
   用 8 时各段标题会和上一段贴在一起。 */
.dcss-tabpanel { gap: 16px; }
.dcss-section {
  /* 不再每块都套边框：一屏 5 个同重量的框只是噪音。
     用留白分组，必要时靠上方那条分隔线（相邻 section 之间）。
     注意：本文件是一段模板字符串，注释里**不能出现反引号**。 */
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 不加分隔线：每个 Section 现在都有标题，分组由标题表达。留白（父级 gap 16px）
   就是唯一的分组信号，一屏不会再出现 28px 与 14px 两套节奏。 */
.dcss-section-title { margin: 0; font-weight: 600; font-size: 13px; }
.dcss-muted { margin: 0; color: var(--dsw-alias-label-tertiary, #6b7280); }
.dcss-error { color: var(--dsw-alias-state-error-primary, #b91c1c); }
.dcss-row {
  display: grid;
  /* 固定标签列。原来用 minmax(96px, max-content)，每行各算各的列宽，同一面板里
     实测出现 96 / 174.7 两种，值于是从两个不同的 x 起排，眼睛没法扫。
     108px 是中文四字标签加 gap 的公倍数。 */
  grid-template-columns: 108px minmax(0, 1fr);
  gap: 4px 12px;
  align-items: baseline;
}
.dcss-label { color: var(--dsw-alias-label-tertiary, #6b7280); }
.dcss-value { min-width: 0; overflow-wrap: anywhere; }
.dcss-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dcss-toolbar-spacer { flex: 1; }
.dcss-button {
  appearance: none;
  font: inherit;
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.18));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, #1f2328);
  cursor: pointer;
}
.dcss-button:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3, rgba(15, 23, 42, 0.3)); }
.dcss-button:disabled { opacity: 0.55; cursor: default; }
/* 键盘用户必须看得见焦点。这里原来和 :disabled 合并成"变半透明"，于是按 Tab
   时按钮只是变灰、没有任何 focus ring ——看起来像没响应。 */
.dcss-button:focus-visible,
.dcss-tab:focus-visible,
.dcss-vendor-tab:focus-visible {
  outline: 2px solid var(--dcss-accent);
  outline-offset: 1px;
}
.dcss-button-primary {
  background: var(--dcss-accent);
  border-color: var(--dcss-accent);
  color: var(--dsw-alias-label-primary-inverted, #fff);
}
.dcss-button-ghost { background: transparent; }
.dcss-badge {
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
.dcss-badge-ok { color: var(--dsw-alias-state-success-primary, #15803d); }
.dcss-badge-danger { color: var(--dsw-alias-state-error-primary, #b91c1c); }
.dcss-notice {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.12));
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1));
}
.dcss-notice-error {
  border-color: var(--dsw-alias-state-error-primary, #b91c1c);
  color: var(--dsw-alias-state-error-primary, #b91c1c);
}

/* Account rows: one compact line per account (identity · badges · figure · action). */
.dcss-acct-list { display: flex; flex-direction: column; gap: 2px; }
.dcss-acct-row {
  /* 严格三格：谁 | 额度 | 动作。
     之前 7 个直接子元素配 3 列网格，第 4 个起每行一个，账号行被撑成三行。
     现在额外内容（重命名框、不可用原因）用 grid-column 跨整行。 */
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  /* 额度与动作之间多留一点：8px 时「40,500 使用此账号」读起来像一个整体。 */
  gap: 4px 12px;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 7px;
  font-size: 12px;
  line-height: 1.5;
}
.dcss-acct-who {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}
/* 跨整行的附属内容：重命名编辑器、账号不可用的原因。 */
.dcss-acct-rename,
/* 批量清理：一行说明 + 一个动作，只在真的有一批无标识账号时出现。 */
.dcss-acct-cleanup {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.08));
}
.dcss-acct-cleanup > /*
 * 错误提示里的一行操作（「重新注册」按钮等）：
 * 提示框是 flex 列布局，操作行贴着文案排、与左侧文字留一个字距。
 */
.dcss-notice-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.dcss-hint { flex: 1 1 auto; min-width: 0; }
.dcss-acct-hint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.14));
  cursor: help;
  flex: 0 0 auto;
}
.dcss-acct-note { grid-column: 1 / -1; }
.dcss-acct-rename { display: flex; align-items: center; gap: 6px; padding-top: 2px; }
/* 批量清理：一行说明 + 一个动作，只在真的有一批无标识账号时出现。 */
.dcss-acct-cleanup {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.08));
}
.dcss-acct-cleanup > .dcss-hint { flex: 1 1 auto; min-width: 0; }
.dcss-acct-hint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.14));
  cursor: help;
  flex: 0 0 auto;
}
.dcss-acct-note { margin: 0; font-size: 11px; color: var(--dsw-alias-state-error-primary, #b91c1c); }
/* 身份列里的徽标与说明不该把行撑开。 */
.dcss-acct-row > .dcss-label,
.dcss-acct-row > .dcss-row-note { display: none; }
.dcss-acct-credits {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  justify-self: end;
  min-width: 7ch;
}
.dcss-acct-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.08)); }
.dcss-acct-row-active { box-shadow: inset 2px 0 0 var(--dcss-accent); }
.dcss-acct-identity {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 40%;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dcss-acct-actions { display: inline-flex; gap: 4px; flex: 0 0 auto; }
.dcss-acct-row .dcss-button { flex: 0 0 auto; width: auto; }
.dcss-row-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}
.dcss-inline-input {
  flex: 0 1 140px;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.14));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, #1f2328);
  font: inherit;
  font-size: 12px;
}

/* Credits: the grid is generated from the capability's credits.fields list. */
.dcss-credit-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
.dcss-credit-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1));
}
.dcss-credit-value { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dcss-credit-value-missing { color: var(--dsw-alias-label-tertiary, #6b7280); font-weight: 400; }
.dcss-credit-headline { box-shadow: inset 2px 0 0 var(--dcss-accent); }
.dcss-ledger { display: flex; flex-direction: column; gap: 2px; }
.dcss-ledger-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.1));
  font-size: 12px;
}
.dcss-ledger-head { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; }
.dcss-ledger-row:last-child { border-bottom: 0; }
.dcss-ledger-time {
  flex: 0 0 auto;
  min-width: 8.6em;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}
.dcss-ledger-model {
  flex: 0 0 auto;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsw-alias-label-secondary, #4b5563);
  max-width: 14em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 表头与数据行共用同一组列宽：原来表头第 3/4 格是无类的裸 span，
   与数据行的元素各算各的宽度，模型列与金额列根本不共线。 */
.dcss-ledger-row {
  display: grid;
  /* 时间列要装下「2026-11-16 14:22」整串（实测 86px 会换行），模型列要装下
     常见 id（deepseek-v4-flash-1017）。 */
  grid-template-columns: 118px minmax(0, 1fr) 168px 76px;
  gap: 8px;
  align-items: baseline;
}
.dcss-ledger-desc { min-width: 0; overflow-wrap: anywhere; }
/* 金额右对齐 + 等宽数字：加减号金额的右边缘才会落在同一条竖线上。 */
.dcss-ledger-amount {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dcss-record-positive { color: var(--dsw-alias-state-success-primary, #15803d); flex: 0 0 auto; }
.dcss-record-negative { color: var(--dsw-alias-state-error-primary, #b91c1c); flex: 0 0 auto; }

/* Login forms: one row per credential field, generated from capabilities.login. */
.dcss-login { display: flex; flex-direction: column; gap: 8px; }
.dcss-login-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dcss-input {
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
.dcss-input:focus {
  outline: none;
  border-color: var(--dcss-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dcss-accent) 22%, transparent);
}
.dcss-input:disabled { opacity: 0.55; cursor: not-allowed; }
.dcss-details { display: flex; flex-direction: column; gap: 6px; }
.dcss-details > .dcss-add-summary { cursor: pointer; }
.dcss-add-summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #4b5563);
  padding: 2px 0;
  user-select: none;
}
.dcss-add-summary:hover { color: var(--dsw-alias-label-primary, #1f2328); }
.dcss-add-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 0 10px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.12));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.08));
}
.dcss-textarea {
  display: block;
  width: 100%;
  box-sizing: border-box;
  min-height: 84px;
  max-height: 220px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.14));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.5;
  resize: vertical;
}
.dcss-textarea:focus {
  outline: none;
  border-color: var(--dcss-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dcss-accent) 22%, transparent);
}
.dcss-add-foot { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.dcss-add-foot .dcss-button { margin-left: auto; flex: 0 0 auto; }

/* Hint / muted copy:辅助说明，必须比正文字小且弱，否则整页都是噪音。 */
.dcss-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  /* 二级灰而不是三级：三级灰在浅色下实测对比度 3.71，12px 小字达不到 AA 的 4.5。 */
  color: var(--dsw-alias-label-secondary, #4b5563);
  white-space: pre-line;
}
/* Paths, ids, header names: monospace so they can be compared character by character. */
.dcss-mono {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #4b5563);
  word-break: break-all;
}
.dcss-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; }
.dcss-link {
  color: var(--dsw-alias-label-link, #2563eb);
  text-decoration: none;
  overflow-wrap: anywhere;
}
.dcss-link:hover { text-decoration: underline; }
/* One diagnostics probe: verdict · path · upstream wording, on one line. */
.dcss-probe {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  padding: 3px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.06));
}
.dcss-probe:last-child { border-bottom: 0; }

/* Config groups: 一组一个标题。十个字段平铺时用户找不到要改的那一项。 */
.dcss-field-group { display: flex; flex-direction: column; gap: 8px; }
.dcss-field-group + .dcss-field-group {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.08));
}
.dcss-field-group-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #4b5563);
}

/* Config: one row per field. Left = what it is, right = what to change it to.
   A table here squeezed the input to ~180px in a 600px column. */
.dcss-field-list { display: flex; flex-direction: column; gap: 10px; }
.dcss-field {
  display: grid;
  /*
   * 标签列必须有下限。原来第一列的下限是 0，被中列（输入框）和右列
   * （默认值 + 恢复默认）挤到几十像素，中文说明被折成每行两三个字的竖排。
   * 150px 够放下「强制按「能识图」提供的模型 id」两行中文。
   */
  grid-template-columns: minmax(150px, 1fr) minmax(160px, 40%) auto;
  gap: 6px 12px;
  align-items: start;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.06));
}
.dcss-field:last-child { border-bottom: 0; padding-bottom: 0; }
.dcss-field-label { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
/* 说明文字是主标题：字段键名对用户没意义，"API 基地址"才是他要找的。 */
.dcss-field-title {
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #1f2328);
}
/* 键名降为副标题：给手改 patch 的人看的，不是给普通用户看的。 */
.dcss-field-name {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dcss-field-control { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dcss-field-control .dcss-input { flex: 1 1 auto; min-width: 0; }
.dcss-field-badge {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--dcss-accent);
  white-space: nowrap;
}
.dcss-field-default {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  max-width: 210px;
}
/* 默认值常常比输入框里的值还长（一个完整 URL）。让它自己截断，别把输入框挤没；
   完整值由 title 提供。 */
.dcss-field-default .dcss-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Models table: the catalog is the densest thing on the card, so it gets
   tabular numbers, a sticky-feeling header row and row hover. */
.dcss-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.dcss-table th {
  text-align: left;
  font-weight: 600;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  padding: 4px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.12));
  white-space: nowrap;
}
.dcss-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.06));
  vertical-align: top;
  font-variant-numeric: tabular-nums;
}
.dcss-table tr:hover td { background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.06)); }
.dcss-table tr:last-child td { border-bottom: 0; }
.dcss-table-models { table-layout: fixed; }
/* 数字列固定宽度并右对齐：多个模型的倍率/上下文才能上下比较。 */
.dcss-table-models th:nth-child(2), .dcss-table-models td:nth-child(2) { width: 64px; }
.dcss-table-models th:nth-child(3), .dcss-table-models td:nth-child(3) { width: 92px; }
.dcss-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dcss-table-models td:first-child { padding-right: 12px; }
/* 三行信息（名字 / id / 元信息）挤在一格里，行距不能再用正文的 1.55。 */
.dcss-table-models td { padding: 6px 8px; line-height: 1.35; }
.dcss-table-models td .dcss-mono,
.dcss-table-models td .dcss-row-note { line-height: 1.3; }
.dcss-table-models .dcss-tick { align-items: flex-start; }
.dcss-table-models .dcss-tick input { margin-top: 2px; }

/* Checkbox + model name on one line; the id sits underneath in mono. */
.dcss-tick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.dcss-tick input { margin: 0; accent-color: var(--dcss-accent); }

/* Models table. */

/* Composer credit readout, sitting just before the model picker. Deliberately
   tiny and shrinkable: the model name must keep its room. */
.dcss-pill-anchor { position: relative; display: inline-flex; }
.dcss-pill-open { background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.12)); }
.dcss-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 132px;
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
.dcss-pill:hover { background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.12)); }
.dcss-pill-sep { color: var(--dsw-alias-label-tertiary, #6b7280); }
.dcss-pill-name {
  color: var(--dsw-alias-label-secondary, #4b5563);
  max-width: 9ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dcss-pill-amount {
  color: var(--dcss-accent);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
/*
 * 读不到额度：数字位是「—」，边框改成虚线。
 *
 * 只是"没有数字"太容易被当成"这家供应商本来就这样"；虚线在视觉上说明这是
 * 一个未完成的读数（原因在 title 里，点开抽屉能看到原文与重试按钮）。
 */
.dcss-pill-missing {
  border-style: dashed;
  border-color: var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.28));
}
.dcss-pill-missing .dcss-pill-amount {
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-weight: 500;
}

/*
 * 配置浮层：从聊天界面就近打开的那一份。
 *
 * 与抽屉不同，它是**模态**的（有遮罩、锁焦点）：配置里可能有未保存的草稿，
 * 一次误点就丢掉说不过去。宽度给到 560px——配置是两列字段布局，260px 会挤坏。
 */
.dcss-sheet-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(15, 23, 42, 0.35);
}
/*
 * 定位层：铺满视口、flex 居中、四边留 16px。
 *
 * 浮层原来用 top/left 50% 加 translate(-50%,-50%) 定位，高度却由内容决定：
 * 内容一长就同时向上下两头溢出，底部那段只能滚动页面才看得到（用户报的现象）。
 * 更糟的是，只要任何一个祖先带 transform / filter / contain，fixed 的包含块就
 * 从视口退化成那个祖先——浮层以一行高的输入框为中心居中，下半截必然出视口。
 * 所以浮层现在 portal 到 body（见 PanelSheet.tsx），并用"永远装得下"的写法：
 * flex + max-height:100%，高度超出时被压回容器，由 .dcss-sheet-body 自己滚动。
 *
 * pointer-events:none 让定位层不挡住下面的遮罩：点空白处仍然关浮层。
 */
.dcss-sheet-layer {
  position: fixed;
  inset: 0;
  z-index: 61;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  pointer-events: none;
}
.dcss-sheet {
  position: relative;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  /* 620px：配置页是「标签 + 输入 + 默认值 + 恢复默认」四列，560px 会把
     地址输入框里的 https://loomyad.xunfei.cn/api/v1 截断。 */
  width: min(620px, 100%);
  max-height: 100%;
  min-height: 0;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.14));
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 24px 64px rgba(15, 23, 42, 0.3);
  overflow: hidden;
}
.dcss-sheet-head {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 12px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.08));
}
.dcss-sheet-head > strong {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  margin-right: 4px;
}
/* 表单区自己滚动：头部与页脚常驻，长表单不会把关闭按钮顶出视野。 */
.dcss-sheet-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  /*
   * 与 .dcss-card 同一个节奏（16px）。
   *
   * 面板是 fragment 直接吐多个块（身份摘要 / 账号段 / 轮换 / 积分 / 流水），
   * 卡片里这些块靠 .dcss-card 的 gap 分组；浮层这边原来只有 padding，
   * 于是「积分」标题紧贴着上面那个轮换开关，看上去像同一个控件的一部分。
   */
  display: flex;
  flex-direction: column;
  gap: 16px;
}
/* tab 条：与设置卡片同一套语义（role=tab + aria-selected），这里只是更紧凑。 */
.dcss-sheet-tabs {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 0 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.08));
}
.dcss-sheet-tab {
  appearance: none;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #4b5563);
  font: inherit;
  font-size: 12px;
  padding: 8px 10px;
  cursor: pointer;
}
.dcss-sheet-tab:hover { color: var(--dsw-alias-label-primary, #1f2328); }
/* 选中态用"主文字色 + 强调色下划线"，不靠颜色单独表达（对比度门禁的理由同卡片）。 */
.dcss-sheet-tab-active {
  color: var(--dsw-alias-label-primary, #1f2328);
  border-bottom-color: var(--dcss-accent, #4f6bed);
  font-weight: 600;
}
/* 浮层里用不到卡片外壳：配置面板本身就是内容。 */
.dcss-sheet-body .dcss-card {
  border: 0;
  box-shadow: none;
  padding: 0;
  width: auto !important;
}

/* Drawer footer: the config entry plus the quiet hint. */
/* Rotation toggle: same checkbox idiom as the settings card, compact for the drawer. */

/* Account drawer: anchored above the badge, never widening the row. */
.dcss-drawer {
  /* 声明 260px，实测渲染 282px：宽度算的是内容盒，padding 与 border 又加了 22px，
     于是抽屉向左溢出、在窄输入框上顶出视口。 */
  box-sizing: border-box;
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 30;
  width: 260px;
  max-height: 340px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.16));
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  box-shadow: 0 8px 28px rgba(15, 23, 42, 0.28);
  text-align: left;
  --dcss-accent: var(--dsw-alias-state-business-primary, #2563eb);
}
.dcss-drawer-head { display: flex; align-items: center; gap: 4px; }
/* 标题占据剩余宽度并允许省略：三个图标按钮固定 24px，标题再长也不该把按钮挤掉。 */
.dcss-drawer-close { margin-left: 2px; }
/* Rotation toggle: same checkbox idiom as the settings card, compact for the drawer. */
.dcss-drawer-pool-toggle {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #4b5563);
  cursor: pointer;
}
.dcss-drawer-pool-toggle input { margin: 2px 0 0; accent-color: var(--dcss-accent); flex: 0 0 auto; }
.dcss-drawer-head > strong {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-right: 4px;
}
/* Icon button: one glyph, a square hit area, and the accessible name supplied by
   aria-label (see common.tsx#IconButton). 24px is the smallest square that is
   still comfortably clickable next to 12px text. */
.dcss-icon-button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  flex: 0 0 auto;
}
.dcss-icon-button:hover {
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dcss-icon-button:focus-visible {
  outline: 2px solid var(--dcss-accent);
  outline-offset: 1px;
}
/* The drawer's close sits at the far right of its header. */
.dcss-drawer-list { display: flex; flex-direction: column; gap: 1px; }
.dcss-drawer-spacer { flex: 1 1 auto; min-width: 4px; }
.dcss-drawer-credits {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, #5b6470);
}
/* One row = [switch button][remove button], on ONE line. flex-wrap:nowrap is the
   point: without it the trailing action wrapped to a second line. */
.dcss-drawer-row-wrap {
  display: flex;
  align-items: center;
  gap: 0;
  width: 100%;
  min-width: 0;
  flex-wrap: nowrap;
}
.dcss-drawer-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.dcss-drawer-row:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1)); }
.dcss-drawer-row:disabled { cursor: default; }
.dcss-drawer-row-active {
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.14));
  font-weight: 600;
}
.dcss-drawer-identity, .dcss-drawer-label, .dcss-drawer-credits, .dcss-drawer-badge { flex: 0 0 auto; }
.dcss-drawer-identity {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dcss-drawer-error {
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary, #b91c1c);
}
.dcss-drawer-label { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; white-space: nowrap; }
/*
 * 状态胶囊：底色必须淡，文字必须实。
 *
 * 这两条曾经写成 background: var(--dsw-alias-state-error-secondary) +
 * color: var(--dsw-alias-state-error-primary)，假定 -secondary 是 12% 的淡底。
 * 宿主对这套别名的定义不是这样：深色主题下 state-error-secondary 是实色
 * #f25a5a，state-business-primary 是实色 #7aaaff —— 底色与字色同值，
 * 「已停用」「最近调用」就被自己的背景涂掉了，胶囊在截图里是一块空红/空蓝。
 *
 * 淡底只能自己从字色调出来（color-mix）。调不出来的老引擎退回中性底：
 * 先声明一条能用的颜色，再用 color-mix 覆盖 —— 不支持的引擎会丢掉后一条。
 */
.dcss-drawer-badge {
  padding: 0 5px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.16));
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #b91c1c) 18%, transparent);
  color: var(--dsw-alias-state-error-primary, #b91c1c);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
/*
 * 「登录已失效」比「轮换已跳过」重一档：前者要用户去重新登录，后者只要等。
 * 临时跳过用中性底色（它是常态，不该在抽屉里抢注意力），登录失效保留红字并加
 * 一道实线边框，扫一眼就能分出哪几行需要动作。
 */
.dcss-drawer-badge-bad {
  border: 1px solid var(--dsw-alias-state-error-primary, #b91c1c);
  font-weight: 600;
}
/*
 * 抽屉顶部的合计：随逐行结果增长。
 *
 * 数字用等宽数位（tabular-nums）——它会一变再变，不等宽的话每来一个账号，
 * 整行都会左右抖一下。
 */
.dcss-drawer-total {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 0 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.08));
}
.dcss-drawer-total-label { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; }
.dcss-drawer-total-amount {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dcss-accent);
}
.dcss-drawer-total-progress {
  margin-left: auto;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-variant-numeric: tabular-nums;
}
.dcss-drawer-check { flex: 0 0 auto; color: var(--dcss-accent); }
.dcss-drawer-lastused {
  /* "最近调用"：轮换时唯一能说明"刚花了谁的钱"的标记。 */
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.16));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563eb) 18%, transparent);
  color: var(--dsw-alias-state-business-primary, #2563eb);
  font-size: 10px;
  line-height: 16px;
  white-space: nowrap;
}


.dcss-title { margin: 0; font-size: 14px; font-weight: 600; }
.dcss-subtitle {
  margin: 0;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  /* 两行封顶：副标题是解释不是正文，再长就在设置页里喧宾夺主。 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Footer: the community block, deliberately the quietest element on the card. */
.dcss-footer {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.08));
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}

/* Row action menu: one visible primary action per account row, the rest behind
   ⋯. Four side-by-side buttons ate nearly half of a 700px column. */
.dcss-row-menu { position: relative; display: inline-flex; }
.dcss-row-menu-trigger { letter-spacing: 1px; }
.dcss-row-menu-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  min-width: 136px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.16));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
}
.dcss-row-menu-item {
  appearance: none;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  padding: 6px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.dcss-row-menu-item:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1)); }
.dcss-row-menu-item:disabled { opacity: 0.55; cursor: default; }
/* 移除是不可逆的：用错误色，和普通菜单项分开。 */
.dcss-row-menu-danger { color: var(--dsw-alias-state-error-primary, #b91c1c); }

/* 按按钮就地展开的表单：**贴着段头**（触发按钮就在标题右侧），列表跟在后面。
   分隔线画在表单与列表之间，而不是表单与段头之间——上面那条线属于段头自己。 */
.dcss-acct-form {
  margin-bottom: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.08));
}
.dcss-acct-form-block { min-width: 0; }
/* 导出/导入面板自带一个圆角浅底盒（.dcss-add-body），它的下边距改为归 .dcss-acct-form 管。 */
.dcss-acct-form > .dcss-add-body { margin-bottom: 0; }
/* 导出组：按钮 + 风险提示同一行，窄列自动换行。 */
.dcss-transfer-export {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dcss-transfer-export .dcss-row-note { flex: 1 1 160px; min-width: 0; }
/* 导入组：说明 → 粘贴框 → 状态 + 确认，纵向；与导出组之间一条细线。 */
.dcss-transfer-import {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.12));
}
.dcss-transfer-import .dcss-row-note { flex: none; }

/* 轮换：账号段里的一行设置，不是独立功能块。 */
.dcss-acct-pool {
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.08));
}

/* A checkbox + wrapping label. Does NOT reuse the account row: that row is
   nowrap + ellipsis for names, so a sentence-length label got cut at 500px. */
.dcss-check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dcss-check-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
}
.dcss-check-label input { margin: 0; accent-color: var(--dcss-accent); }


/* ── 容器查询 ────────────────────────────────────────────────────────────
   必须放在基础规则**之后**：同优先级下后写的赢，写在前面等于没生效（踩过）。 */
@container (max-width: 520px) {
  /* 窄列：页脚纵向、身份不截断、配置字段改单列。用容器查询而不是视口查询——
     卡片住在 600-700px 的列里，视口宽度不会小于 520，那条规则从未生效过。 */
  .dcss-footer { flex-direction: column; align-items: flex-start; }
  .dcss-statusbar-identity { max-width: 100%; }
  .dcss-field { grid-template-columns: minmax(0, 1fr); }
  .dcss-field-default { justify-content: flex-start; }
}

@container (max-width: 460px) {
  /* 很窄（分屏 / 手机横屏）：四列流水表装不下——118+168+76 的固定列在 380px
     里会横向溢出（实测 overflow 命中 dcss-card）。丢掉"模型"这一列：它
     是次要信息，而时间、事项、金额是看流水时真正要比的三件事。 */
  .dcss-ledger-row { grid-template-columns: 104px minmax(0, 1fr) 66px; }
  .dcss-ledger-model { display: none; }
  .dcss-table-models th:nth-child(3),
  .dcss-table-models td:nth-child(3) { width: 74px; }
}
`

/**
 * Revision of the stylesheet body.
 *
 * WHY A REVISION AND NOT JUST AN ID. A hot reload re-evaluates the bundle while
 * the old `<style>` tag stays in the document; an id-only guard then keeps the
 * stale sheet and pairs new markup with old rules. Bumping this constant on
 * every CSS change makes the next `ensureStyles()` replace it in place.
 */
export const STYLE_REVISION = 'v61-layout-rhythm'

/**
 * Inject the stylesheet once per document revision. Safe to call during render:
 * it is idempotent and a no-op outside a DOM (SSR, jsdom without a document).
 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_TAG_ID}"]`)
  if (existing !== null && existing.dataset.revision === STYLE_REVISION) return
  const tag = existing ?? document.createElement('style')
  tag.dataset.plugin = 'dsh-connect-desktop'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.dataset.revision = STYLE_REVISION
  tag.textContent = CARD_CSS
  if (existing === null) document.head.appendChild(tag)
}
