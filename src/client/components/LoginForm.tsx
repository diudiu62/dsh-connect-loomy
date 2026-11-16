/**
 * The SMS login form inside the account tab.
 *
 * Three states, strictly user-driven:
 * - idle: phone input + "send code";
 * - sent: code input + countdown, resend disabled until the cooldown ends;
 * - signed in: masked phone + "sign out" (plugin-side session only).
 *
 * Every failure surfaces the host's executable message verbatim — the card
 * never invents a reason. The plugin's session takes precedence over the
 * desktop client's; signing out falls back to it automatically, which the
 * sign-out notice says so nobody mistakes the fallback for a bug.
 *
 * @module dsh-connect-loomy/client/components/LoginForm
 */

import { useEffect, useRef, useState } from 'react'
import { authLogin, authLogout, authSendCode, type LoomyAuthState } from '../api.js'
import { loadableMessage, type LoomyT } from './types.js'
import { CardButton, Notice } from './common.js'

export interface LoginFormProps {
  t: LoomyT
  /** Process-level CSRF token from `/status`; null while the card loads. */
  csrfToken: string | null
  /** Current sign-in state (used for the signed-in branch). */
  authState: LoomyAuthState | null
  /** Called after a login or logout so the card re-reads /status. */
  onChanged: () => void
  /** Abort signal for in-flight calls. */
  signal?: AbortSignal
}

interface SentState {
  phone: string
  resendAt: number
  expiresAt: number
}

const TICK_MS = 1_000

/** One executable message from any failed route result (host text wins). */
function routeErrorMessage<T>(result: { kind: string; message?: string; value?: { error?: { message?: string }; message?: string } }): string | undefined {
  if (result.kind === 'ok') return result.value?.error?.message
  if (result.kind === 'unavailable') return undefined
  return result.message
}

/** Render the SMS login flow (or the signed-out / signed-in states around it). */
export function LoginForm({ t, csrfToken, authState, onChanged, signal }: LoginFormProps) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState<SentState | null>(null)
  const [busy, setBusy] = useState<'send' | 'login' | 'logout' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [nowTick, setNowTick] = useState(Date.now())
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  // Countdown ticker while a code is pending.
  useEffect(() => {
    if (sent === null) return undefined
    timerRef.current = setInterval(() => setNowTick(Date.now()), TICK_MS)
    return () => {
      if (timerRef.current !== undefined) clearInterval(timerRef.current)
    }
  }, [sent])

  // Expire the pending code client-side; the server enforces its own window.
  useEffect(() => {
    if (sent !== null && nowTick > sent.expiresAt) setSent(null)
  }, [nowTick, sent])

  const sendCode = async (): Promise<void> => {
    if (csrfToken === null || busy !== null) return
    setBusy('send')
    setError(null)
    setNotice(null)
    try {
      const result = await authSendCode(csrfToken, phone.trim(), signal === undefined ? {} : { signal })
      if (result.kind === 'ok' && result.value.ok) {
        setSent({
          phone: phone.trim(),
          resendAt: Date.now() + (result.value.resendAfterMs ?? 60_000),
          expiresAt: Date.now() + (result.value.expiresMs ?? 300_000),
        })
        setCode('')
        setNotice(t('login.codeSent', { phone: result.value.maskedPhone ?? phone.trim() }))
        return
      }
      setError(routeErrorMessage(result) ?? t('login.sendFailed'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('login.sendFailed'))
    } finally {
      setBusy(null)
    }
  }

  const login = async (): Promise<void> => {
    if (csrfToken === null || sent === null || busy !== null) return
    setBusy('login')
    setError(null)
    setNotice(null)
    try {
      const result = await authLogin(csrfToken, sent.phone, code.trim(), signal === undefined ? {} : { signal })
      if (result.kind === 'ok' && result.value.ok) {
        setSent(null)
        setCode('')
        setNotice(t('login.success'))
        onChanged()
        return
      }
      setError(routeErrorMessage(result) ?? t('login.failed'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('login.failed'))
    } finally {
      setBusy(null)
    }
  }

  const logout = async (): Promise<void> => {
    if (csrfToken === null || busy !== null) return
    setBusy('logout')
    setError(null)
    setNotice(null)
    try {
      const result = await authLogout(csrfToken, signal === undefined ? {} : { signal })
      if (result.kind === 'ok' && result.value.ok) {
        setNotice(result.value.message)
        onChanged()
        return
      }
      const message = result.kind === 'ok' ? result.value.message : routeErrorMessage(result)
      setError(message ?? t('login.logoutFailed'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('login.logoutFailed'))
    } finally {
      setBusy(null)
    }
  }

  const cooldownLeft = sent === null ? 0 : Math.max(0, Math.ceil((sent.resendAt - nowTick) / 1_000))
  const phoneValid = /^1[3-9]\d{9}$/u.test(phone.trim())
  const codeValid = /^\d{4,8}$/u.test(code.trim())
  const pluginLoggedIn = authState?.pluginLoggedIn === true

  if (pluginLoggedIn) {
    return (
      <div className="loomy-login">
        <Notice tone="ok">{t('login.pluginActive')}</Notice>
        <div className="loomy-actions">
          <CardButton onClick={() => void logout()} disabled={busy !== null || csrfToken === null}>
            {busy === 'logout' ? t('login.loggingOut') : t('login.logout')}
          </CardButton>
        </div>
        {notice !== null ? <Notice tone="ok">{notice}</Notice> : null}
        {error !== null ? <Notice tone="error">{error}</Notice> : null}
      </div>
    )
  }

  return (
    <div className="loomy-login">
      <p className="loomy-muted">{t('login.intro')}</p>
      <div className="loomy-login-row">
        <input
          className="loomy-input"
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          placeholder={t('login.phonePlaceholder')}
          value={phone}
          maxLength={11}
          disabled={busy !== null || sent !== null}
          aria-label={t('login.phonePlaceholder')}
          onChange={(event) => setPhone(event.target.value.replace(/\D/gu, ''))}
        />
        <CardButton
          onClick={() => void sendCode()}
          disabled={busy !== null || csrfToken === null || !phoneValid || sent !== null}
        >
          {busy === 'send' ? t('login.sending') : t('login.sendCode')}
        </CardButton>
      </div>
      {sent !== null ? (
        <div className="loomy-login-row">
          <input
            className="loomy-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder={t('login.codePlaceholder')}
            value={code}
            maxLength={8}
            disabled={busy !== null}
            aria-label={t('login.codePlaceholder')}
            onChange={(event) => setCode(event.target.value.replace(/\D/gu, ''))}
          />
          <CardButton
            onClick={() => void login()}
            disabled={busy !== null || csrfToken === null || !codeValid}
          >
            {busy === 'login' ? t('login.loggingIn') : t('login.login')}
          </CardButton>
          <CardButton
            onClick={() => void sendCode()}
            disabled={busy !== null || cooldownLeft > 0}
          >
            {cooldownLeft > 0 ? t('login.resendIn', { seconds: cooldownLeft }) : t('login.resend')}
          </CardButton>
        </div>
      ) : null}
      {notice !== null ? <Notice tone="ok">{notice}</Notice> : null}
      {error !== null ? <Notice tone="error">{error}</Notice> : null}
    </div>
  )
}
