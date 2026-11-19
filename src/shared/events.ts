/**
 * The one loader event this plugin subscribes to.
 *
 * `loader/volatile-update` is published by the cordis loader when a settings
 * write changes a `.volatile()` field. The event is part of the loader
 * package's ambient types, which are not installed in this repository (the
 * loader is a host package, not an npm dependency we compile against), so the
 * declaration is repeated here. It is additive and identical to the host's:
 * a no-argument notification that the live config object changed.
 *
 * @module dsh-connect-desktop/shared/events
 */

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** The loader republished volatile configuration fields in place. */
    'loader/volatile-update'(): void
  }
}

export {}
