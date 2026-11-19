/**
 * The plugin's own glyph for the settings **navigation row**.
 *
 * `settings.section.icon` is DSH's dedicated seat for this: the shell renders
 * whatever the registrant puts there instead of its fallback settings gear, and
 * passes `{ size, active }` down. Without a registration every plugin section
 * shows the same generic gear, which is exactly what makes a sidebar full of
 * plugins unreadable at a glance.
 *
 * WHY INLINE SVG RATHER THAN `icons/icon-128.png`. The nav cell asks for a
 * **16px** square. Shipping the 128px raster would mean a raster downscale at
 * every DPR (soft edges on 1x, muddy on 3x), a new host route to serve the file
 * (the host exposes five JSON routes and nothing else), and a network round
 * trip before the sidebar paints. A vector path is a few hundred bytes inside
 * the bundle we already load, and stays crisp at any size.
 *
 * The geometry is traced from the shipped app icon, so the nav row and the
 * market entry are the same mark: a `#344DFD` rounded square (r≈22%), the white
 * "L" with its rounded foot, and the `#37E1BE` dot at the foot's outer corner.
 * The dot is drawn last on purpose — it sits *on* the L's corner, as in the
 * source art.
 *
 * @module dsh-connect-desktop/client/components/BrandIcon
 */

/** Brand blue, sampled from `icons/icon-128.png`. */
const BRAND_BLUE = '#344DFD'

/** Brand teal (the dot), sampled from the same file. */
const BRAND_TEAL = '#37E1BE'

/** Owner props the settings shell supplies to `settings.section.icon`. */
export interface DesktopModelsIconProps {
  /** Requested square edge in pixels (the shell passes 16). */
  size?: number
  /** Whether the section is the active one. */
  active?: boolean
}

/**
 * Render the brand mark.
 *
 * Decorative by construction: the nav row already renders the section label as
 * its accessible name, so repeating it here would make screen readers announce
 * "桌面模型, 桌面模型". Hence `aria-hidden` + `role="presentation"`.
 *
 * `active` is accepted but not used to recolor: this is a *brand* mark, and
 * swapping its fill with the selection state would make the same plugin look
 * like two different products between rows. Selection is already carried by the
 * row's own background (`--dsw-specific-sidebar-nav-item-active`).
 *
 * @param props - size in CSS pixels; defaults to the shell's 16.
 */
export function DesktopModelsIcon({ size = 16 }: DesktopModelsIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      role="presentation"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flex: 'none' }}
    >
      <rect width="128" height="128" rx="28" fill={BRAND_BLUE} />
      {/* White L: stem x42..58 y28..88, foot to x85 with a r7 rounded tip. */}
      <path
        d="M45 28 H55 A3 3 0 0 1 58 31 V72 H78 A7 7 0 0 1 85 79 V81 A7 7 0 0 1 78 88 H45 A3 3 0 0 1 42 85 V31 A3 3 0 0 1 45 28 Z"
        fill="#FFFFFF"
      />
      <circle cx="92" cy="89" r="9.5" fill={BRAND_TEAL} />
    </svg>
  )
}
