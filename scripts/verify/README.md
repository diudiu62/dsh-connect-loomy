# Independent verification scripts (t5 core suite + t9 repair probes + vision path)

Everything here drives the **built artifacts** (`lib/`) through real HTTP on
127.0.0.1 — no source imports, no fetch doubles, no stubbed transport. Each
script is standalone and prints `PASS`/`FAIL` per check with a final summary;
the exit code is non-zero if any check failed.

| script | proves |
| --- | --- |
| `verify-entry-artifacts.mjs` | every path `package.json` promises exists and works (`main`/`types`/`exports`/`bin`/`files`/locale/cordis patch); the client bundle is a `__ModuleLoader__` factory requiring only platform seeds; the CLI has a shebang + exec bit and runs `--help` |
| `verify-auth-override.mjs` | the pi-ai auth-override echo (`{auth:{apiKey}}`) reaches the wire; returning `undefined` fails with **zero** requests; the shipped `createProviderRuntime` behaves like the echoing provider; platform paths use `token:` only and the mock gateway rejects cross-plane headers |
| `verify-e2e-fake-upstream.mjs` | streaming + single-frame answers finish with `stop`; `[DONE]` without `finish_reason` is a retryable `TRANSPORT` failure (never success); every chat request carries `Authorization: Bearer` + `traceparent`/`chatid`/`msgid`/`loomy-version`/`invokeorigin`; state cache is `0600` and session-free |
| `verify-vision-attachments.mjs` | vision path: a real `dsh-attachment-local` store admits a real PNG and serves `readImageRequest`; `createProviderRuntime` forwards `resolveAttachments`/`resolveImageAccess`; a durable image reaches the wire as `image_url` + `data:image/png;base64,…` (the only form the gateway accepts) with the handle text and Bearer/tracing headers intact; a host without an attachment provider fails before I/O with actionable Chinese text naming `ctx.attachments` and `dsh-attachment-local`; a text-only model keeps the plain capability error |
| `verify-contract-v2.mjs` | `GET /status` always carries `enabledModelIds`; `POST /refresh` returns the saved selection (not a draft); `POST /save` persists, hot-updates the live model list and emits `llm/models-updated`; rejected mutations don't persist |
| `verify-credential-hygiene.mjs` | no exact real session/phone/userid anywhere in the shipped tree, `lib/`, or CLI stdout/stderr; `status --json`/`doctor --json` exit 0 with masked account + balances |
| `run-all.mjs` | runs the core suite above (five t5 scripts + `verify-vision-attachments.mjs`) and aggregates the exit code |
| `verify-cold-start.mjs` | repair F1 (t9): `apply()` mounts synchronously with 0 upstream requests; a signed-in mount warms the catalog with exactly one background `/models`; a failing warm-up is swallowed; a stale catalog is kicked at most once per TTL window for any number of reads; observation N1 (warm-up also runs when `enabled=false`) is pinned as known behaviour |
| `verify-auth-env-exclusive.mjs` | repair F2 (t9): `LOOMY_AUTH_SESSION_FILE` is an exclusive replacement — env set (even to a missing path) never inspects the desktop defaults, blank/unset restores them; the mounted plugin reports signed out under the same conditions; the CLI `--help` documents the semantics |
| `verify-transport-precheck.mjs` | repair F3 (t9): only an **empty, zero-token** `TRANSPORT` terminal forces one identity precheck, and only a **definite** verdict upgrades it to `MISSING_CREDENTIAL`; streams with content or non-zero usage keep `TRANSPORT` with no probe; the `prepareCall().stream()` production path is guarded too; an indefinite probe keeps the original retryable failure |
| `run-repairs.mjs` | runs the three repair probes above and aggregates the exit code |
| `clean-checkout.sh` | copies the checkout without `node_modules`/`lib`/recon state, then runs install → typecheck → test (pretest builds) → build → test → `pnpm check` → t5 core suite → repair probes, recording every exit code |

## Run

```bash
pnpm install
pnpm build
node scripts/verify/run-all.mjs      # t5 core suite, exit 0 = all checks passed
node scripts/verify/run-repairs.mjs  # t9 repair probes (F1/F2/F3)
bash scripts/verify/clean-checkout.sh
```

`verify-credential-hygiene.mjs` needs this machine's real Loomy login state to
perform exact-value matching; without it the check reports **not verified**
(a failure, never a silent pass). The other scripts never read the real
credential file — `mock-upstream.mjs` supplies a synthetic `auth-session.json`
and redirects `HOME`/`DSH_HOME` into a temp directory.
