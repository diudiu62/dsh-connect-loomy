/**
 * Small local atoms for the settings card.
 *
 * The card deliberately does not import `@deepseek-ai/dsh-client-ui-primitives`:
 * the few elements it needs (button, badge, bordered section, notice) are
 * trivial, and keeping the bundle dependency-light means a primitive-version
 * skew cannot break the settings page for the rest of the host. Styling goes
 * through the `--dsw-*` tokens plus `--dcss-accent` in `styles.ts`.
 *
 * @module dsh-connect-desktop/client/components/common
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

/** Button with the card's three visual weights. */
export interface CardButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost'
}

/** A plain `<button>` carrying `dcss-button`. */
export function CardButton({ variant = 'default', className, type = 'button', ...rest }: CardButtonProps) {
  const classes = ['dcss-button']
  if (variant === 'primary') classes.push('dcss-button-primary')
  if (variant === 'ghost') classes.push('dcss-button-ghost')
  if (typeof className === 'string' && className.length > 0) classes.push(className)
  return <button {...rest} type={type} className={classes.join(' ')} />
}

/**
 * 图标按钮：视觉上只有一个字形，**无障碍名称由 `label` 提供**。
 *
 * 为什么不用单纯的 `<button>×</button>`：屏幕阅读器会念出"乘号"，而这里要表达的是
 * "关闭"。`aria-label` 是这类图标按钮唯一正确的命名方式，`title` 只做鼠标悬停提示。
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, glyph = '×', onClick, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={['dcss-icon-button', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      onClick={onClick}
      {...rest}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  )
})

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className' | 'children'> {
  /** 无障碍名称，也是悬停提示；必须是有意义的动词。 */
  label: string
  /** 视觉字形，默认乘号。 */
  glyph?: string
  onClick: () => void
  className?: string
}

/** Inline status pill. */
export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: 'neutral' | 'ok' | 'danger'
  children: ReactNode
  /** 可选的原生提示：用于解释标记含义（例如"最近调用"）。 */
  title?: string
}) {
  const classes = ['dcss-badge']
  if (tone === 'ok') classes.push('dcss-badge-ok')
  if (tone === 'danger') classes.push('dcss-badge-danger')
  return (
    <span className={classes.join(' ')} {...(title === undefined ? {} : { title })}>
      {children}
    </span>
  )
}

/** A bordered group with a heading. */
export function Section({
  title,
  actions,
  children,
  cap,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
  /**
   * Capability marker (`data-dcss-cap`), so the capability-matrix test can
   * assert "declared capability == rendered control set" from the DOM instead of
   * from a selector that a refactor may rename.
   */
  cap?: string
}) {
  return (
    <section className="dcss-section" {...(cap === undefined ? {} : { 'data-dcss-cap': cap })}>
      <div className="dcss-toolbar">
        {/* 是 h3 而不是 span：整张卡片原来只有一个 h2，屏幕阅读器没法按标题在
            6 个块之间跳转。h3 自带 UA 外边距，所以样式里必须 margin: 0。 */}
        <h3 className="dcss-section-title">{title}</h3>
        <span className="dcss-toolbar-spacer" />
        {actions}
      </div>
      {children}
    </section>
  )
}

/** A boxed informational or error message. */
export function Notice({ tone = 'info', children }: { tone?: 'info' | 'ok' | 'error'; children: ReactNode }) {
  const classes = ['dcss-notice']
  if (tone === 'error') classes.push('dcss-notice-error')
  return <div className={classes.join(' ')}>{children}</div>
}

/** Label/value pair used by the account and diagnostics fact tables. */
export function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dcss-row">
      <span className="dcss-label">{label}</span>
      <span className="dcss-value">{children}</span>
    </div>
  )
}
