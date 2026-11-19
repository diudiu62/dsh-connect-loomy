/**
 * Where users reach the author and each other.
 *
 * This module is the **single** place for community contacts: the settings
 * card's footer, `dsh-connect-desktop --help` and the README quote it, so a group
 * number changes here once instead of drifting across three files.
 *
 * `[QQ_GROUP]` / `[WECHAT_ID]` / `[EMAIL]` are deliberate placeholders: they are
 * filtered out by {@link communityChannels}, so an unreleased value can never
 * reach the card as a dead group number. Fill one in and it appears — no code
 * change, and {@link isPlaceholder} is also what the tests assert on, so a
 * leftover placeholder cannot silently ship as if it were real.
 *
 * The GitHub links are the always-available channel; they are never filtered.
 *
 * @module dsh-connect-desktop/shared/community
 */

/** Project home. */
export const REPOSITORY_URL = 'https://github.com/diudiu62/dsh-connect-loomy'

/** Bug reports and feature requests. */
export const ISSUES_URL = `${REPOSITORY_URL}/issues`

/** Every contact point, in the order the card renders them. */
export const COMMUNITY = {
  /** Always available. */
  issues: ISSUES_URL,
  /**
   * Group chat (QQ), the maintainer's own group.
   *
   * Rendered as plain text, not a link: QQ's join URL needs a per-group `k`
   * key, so a number is the only thing that can be stated truthfully.
   */
  qqGroup: '537149884',
  /** Group chat (WeChat). Replace with a group invite or the maintainer id. */
  wechat: '[WECHAT_ID]',
  /** Mailbox for private reports (security, credentials). */
  email: '[EMAIL]',
} as const

/** One contact slot. */
export type CommunityChannel = keyof typeof COMMUNITY

/** The `[UPPER_CASE]` form this file uses for "not filled in yet". */
const PLACEHOLDER_PATTERN = /^\[[A-Z0-9_]+\]$/u

/** True when a contact value is still a placeholder (or empty). */
export function isPlaceholder(value: string): boolean {
  return value.trim().length === 0 || PLACEHOLDER_PATTERN.test(value.trim())
}

/**
 * The contacts that are actually usable.
 *
 * Empty and placeholder values are dropped, so a half-filled
 * {@link COMMUNITY} renders as "GitHub only" instead of an invitation to a
 * group nobody can join. Pass an override to preview a filled-in table (tests
 * do exactly that).
 */
export function communityChannels(
  source: Readonly<Record<CommunityChannel, string>> = COMMUNITY,
): CommunityChannel[] {
  return (Object.keys(source) as CommunityChannel[]).filter((channel) => {
    const value = source[channel]
    return typeof value === 'string' && !isPlaceholder(value)
  })
}

/**
 * The URL a contact should be rendered as, or `undefined` when it is text.
 *
 * QQ groups have no stable join URL derivable from the number, so they stay
 * plain text; the mailbox becomes `mailto:` and GitHub stays as-is.
 */
export function communityHref(channel: CommunityChannel, value: string): string | undefined {
  if (channel === 'issues') return value
  if (channel === 'email') return `mailto:${value.trim()}`
  return undefined
}
