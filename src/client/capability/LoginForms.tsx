/**
 * Login forms, generated from `capabilities.login`.
 *
 * The declaration is a list, and the list is the UI:
 *
 * - `['sms-code']` → phone + code, with a resend countdown;
 * - `['sms-code','password']` → a method switch, because a vendor that accepts
 *   both owes the user a choice;
 * - `['password']` → phone + password;
 * - `['none']` → **no form at all**: the vendor borrows the desktop client's
 *   session, so there is nothing to type. The account panel names that source
 *   instead of offering a login that cannot work.
 *
 * Every failure prints the host's message verbatim. The components never invent
 * a reason: "验证码错误" has to come from the side that knows.
 *
 * @module dsh-connect-desktop/client/capability/LoginForms
 */

import { useEffect, useRef, useState } from 'react'
import type {
  AuthLoginView,
  AuthLogoutView,
  AuthSendCodeView,
  AuthStateView,
  LoginMethod,
} from '../../shared/views.js'
import { requestVendor, type TransportResult } from '../transport.js'
import { CardButton, Notice } from '../components/common.js'
import { type CardT, type Loadable } from '../components/types.js'

/** The two methods that need a form; `none` deliberately is not one of them. */
type FormMethod = 'sms-code' | 'password'

export interface LoginFormsProps {
  t: CardT
  vendorId: string
  csrf: string | null
  methods: readonly LoginMethod[]
  authState: Loadable<AuthStateView>
  /** Called after a login or logout so the card re-reads `/status`. */
  onChanged: () => void
}

/** Executable message for any non-ok transport result. */
export function transportMessage(
  result: TransportResult<unknown>,
  t: CardT,
  fallback: string,
): string | undefined {
  if (result.kind === 'ok') return undefined
  if (result.kind === 'unavailable') {
    return result.reason === 'network' ? t('errors.network', { message: result.message }) : t('errors.unavailable')
  }
  return result.message.length > 0 ? result.message : fallback
}

interface SentState {
  /** 用户输入的**原始**手机号：提交时必须用它（脱敏值只进文案）。 */
  phone: string
  resendAt: number
  expiresAt: number
}

const TICK_MS = 1_000

/** Render the declared login method(s). */
export function LoginForms({ t, vendorId, csrf, methods, authState, onChanged }: LoginFormsProps) {
  const sms = methods.includes('sms-code')
  const password = methods.includes('password')
  const [method, setMethod] = useState<FormMethod>(sms ? 'sms-code' : 'password')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [secret, setSecret] = useState('')
  const [sent, setSent] = useState<SentState | null>(null)
  const [busy, setBusy] = useState<'send' | 'login' | 'logout' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [nowTick, setNowTick] = useState(Date.now())
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  useEffect(() => {
    if (sent === null) return undefined
    timerRef.current = setInterval(() => setNowTick(Date.now()), TICK_MS)
    return () => {
      if (timerRef.current !== undefined) clearInterval(timerRef.current)
    }
  }, [sent])

  // Expire the pending code client-side; the host enforces its own window.
  useEffect(() => {
    if (sent !== null && nowTick > sent.expiresAt) setSent(null)
  }, [nowTick, sent])

  if (!sms && !password) return null

  const signedIn = authState.kind === 'ready' && authState.value.pluginLoggedIn
  if (signedIn) {
    return (
      <div className="dcss-login" data-dcss-cap="login">
        <Notice tone="ok">{t('login.pluginActive')}</Notice>
        <div className="dcss-toolbar">
          <CardButton onClick={() => void logout()} disabled={busy !== null || csrf === null}>
            {busy === 'logout' ? t('login.loggingOut') : t('login.logout')}
          </CardButton>
        </div>
        {notice === null ? null : <Notice tone="ok">{notice}</Notice>}
        {error === null ? null : <Notice tone="error">{error}</Notice>}
      </div>
    )
  }

  const phoneValid = /^1[3-9]\d{9}$/u.test(phone.trim())
  const codeValid = /^\d{4,8}$/u.test(code.trim())
  const passwordValid = secret.length > 0
  const cooldownLeft = sent === null ? 0 : Math.max(0, Math.ceil((sent.resendAt - nowTick) / 1_000))

  async function sendCode(): Promise<void> {
    if (csrf === null || busy !== null) return
    setBusy('send')
    setError(null)
    setNotice(null)
    const result = await requestVendor<AuthSendCodeView>({
      vendorId,
      suffix: 'auth/send-code',
      method: 'POST',
      csrf,
      body: { phone: phone.trim() },
    })
    setBusy(null)
    if (result.kind === 'ok') {
      // `result.phone` 是宿主给的**脱敏**值（`138****0000`）：它只能进文案，
      // 绝不能当作提交值——否则第二步会用掩码手机号去登录，上游必然拒绝。
      setSent({
        phone: phone.trim(),
        resendAt: Date.now() + (result.value.resendAfterMs ?? 60_000),
        expiresAt: Date.now() + (result.value.expiresMs ?? 300_000),
      })
      setCode('')
      setNotice(t('login.codeSent', { phone: result.value.phone ?? phone.trim() }))
      return
    }
    setError(transportMessage(result, t, t('login.sendFailed')) ?? null)
  }

  async function login(): Promise<void> {
    if (csrf === null || busy !== null) return
    setBusy('login')
    setError(null)
    setNotice(null)
    const body =
      method === 'password'
        ? { phone: phone.trim(), password: secret, method: 'password' }
        : { phone: sent?.phone ?? phone.trim(), code: code.trim(), method: 'sms-code' }
    const result = await requestVendor<AuthLoginView>({
      vendorId,
      suffix: 'auth/login',
      method: 'POST',
      csrf,
      body,
    })
    setBusy(null)
    if (result.kind === 'ok') {
      setSent(null)
      setCode('')
      setSecret('')
      setNotice(t('login.success'))
      onChanged()
      return
    }
    setError(transportMessage(result, t, t('login.failed')) ?? null)
  }

  async function logout(): Promise<void> {
    if (csrf === null || busy !== null) return
    setBusy('logout')
    setError(null)
    setNotice(null)
    const result = await requestVendor<AuthLogoutView>({
      vendorId,
      suffix: 'auth/logout',
      method: 'POST',
      csrf,
    })
    setBusy(null)
    if (result.kind === 'ok') {
      setNotice(result.value.message ?? null)
      onChanged()
      return
    }
    setError(transportMessage(result, t, t('login.logoutFailed')) ?? null)
  }

  return (
    <div className="dcss-login" data-dcss-cap="login">
      <p className="dcss-muted">{t('login.intro')}</p>
      {sms && password ? (
        <div className="dcss-toolbar" role="radiogroup" aria-label={t('login.title')}>
          <button
            type="button"
            role="radio"
            aria-checked={method === 'sms-code'}
            className={`dcss-button${method === 'sms-code' ? ' dcss-button-primary' : ''}`}
            onClick={() => setMethod('sms-code')}
          >
            {t('login.method.sms')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={method === 'password'}
            className={`dcss-button${method === 'password' ? ' dcss-button-primary' : ''}`}
            onClick={() => setMethod('password')}
          >
            {t('login.method.password')}
          </button>
        </div>
      ) : null}

      <div className="dcss-login-row">
        <input
          className="dcss-input"
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          placeholder={t('login.phonePlaceholder')}
          aria-label={t('login.phone')}
          value={phone}
          maxLength={11}
          disabled={busy !== null || (method === 'sms-code' && sent !== null)}
          onChange={(event) => setPhone(event.target.value.replace(/\D/gu, ''))}
        />
        {method === 'sms-code' ? (
          <CardButton
            onClick={() => void sendCode()}
            disabled={busy !== null || csrf === null || !phoneValid || sent !== null}
          >
            {busy === 'send' ? t('login.sending') : t('login.sendCode')}
          </CardButton>
        ) : null}
      </div>

      {method === 'sms-code' && sent !== null ? (
        <div className="dcss-login-row">
          <input
            className="dcss-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder={t('login.codePlaceholder')}
            aria-label={t('login.code')}
            value={code}
            maxLength={8}
            disabled={busy !== null}
            onChange={(event) => setCode(event.target.value.replace(/\D/gu, ''))}
          />
          <CardButton onClick={() => void login()} disabled={busy !== null || csrf === null || !codeValid}>
            {busy === 'login' ? t('login.submitting') : t('login.submit')}
          </CardButton>
          <CardButton onClick={() => void sendCode()} disabled={busy !== null || cooldownLeft > 0}>
            {cooldownLeft > 0 ? t('login.resendIn', { seconds: cooldownLeft }) : t('login.resend')}
          </CardButton>
        </div>
      ) : null}

      {method === 'password' ? (
        <div className="dcss-login-row">
          <input
            className="dcss-input"
            type="password"
            autoComplete="current-password"
            placeholder={t('login.passwordPlaceholder')}
            aria-label={t('login.password')}
            value={secret}
            disabled={busy !== null}
            onChange={(event) => setSecret(event.target.value)}
          />
          <CardButton onClick={() => void login()} disabled={busy !== null || csrf === null || !passwordValid}>
            {busy === 'login' ? t('login.submitting') : t('login.submit')}
          </CardButton>
        </div>
      ) : null}

      {notice === null ? null : <Notice tone="ok">{notice}</Notice>}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
    </div>
  )
}
