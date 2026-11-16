/**
 * Small local atoms for the settings card.
 *
 * The card deliberately does not import `@deepseek-ai/dsh-client-ui-primitives`:
 * the few elements it needs (button, badge, bordered section, notice) are
 * trivial, and keeping the bundle dependency-light means a primitive-version
 * skew cannot break the settings page for the rest of the host. Styling goes
 * through the `--dsw-*` tokens in `styles.ts`.
 *
 * @module dsh-connect-loomy/client/components/common
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react'

/** Button with the card's three visual weights. */
export interface CardButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost'
}

/** A plain `<button>` carrying `loomy-button`. */
export function CardButton({ variant = 'default', className, type = 'button', ...rest }: CardButtonProps) {
  const classes = ['loomy-button']
  if (variant === 'primary') classes.push('loomy-button-primary')
  if (variant === 'ghost') classes.push('loomy-button-ghost')
  if (typeof className === 'string' && className.length > 0) classes.push(className)
  return <button {...rest} type={type} className={classes.join(' ')} />
}

/** Inline status pill. */
export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'ok' | 'danger'
  children: ReactNode
}) {
  const classes = ['loomy-badge']
  if (tone === 'ok') classes.push('loomy-badge-ok')
  if (tone === 'danger') classes.push('loomy-badge-danger')
  return <span className={classes.join(' ')}>{children}</span>
}

/** A bordered group with a heading. */
export function Section({
  title,
  actions,
  children,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="loomy-section">
      <div className="loomy-toolbar">
        <span className="loomy-section-title">{title}</span>
        <span className="loomy-toolbar-spacer" />
        {actions}
      </div>
      {children}
    </section>
  )
}

/** A boxed informational or error message. */
export function Notice({ tone = 'info', children }: { tone?: 'info' | 'ok' | 'error'; children: ReactNode }) {
  const classes = ['loomy-notice']
  if (tone === 'error') classes.push('loomy-notice-error')
  return <div className={classes.join(' ')}>{children}</div>
}

/** Label/value pair used by the account and diagnostics fact tables. */
export function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="loomy-row">
      <span className="loomy-label">{label}</span>
      <span className="loomy-value">{children}</span>
    </div>
  )
}
