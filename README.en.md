# dsh-connect-loomy

<p align="center">
  <img src="icons/icon-180.png" width="120" alt="dsh-connect-loomy icon" />
</p>

Connects the chat models of a locally signed-in **Loomy** (iFlytek office assistant) to the DeepSeek Harness model picker, with a settings section (account / models / diagnostics) and a read-only credits readout in the composer.

English | [中文](README.md)

> The plugin reads one JSON file written by the Loomy desktop app at sign-in and never launches the app itself: sign in once, keep Loomy closed afterwards. It provides no accounts, shares no credentials, and bypasses no billing — every call spends your own Loomy credits at the rate the upstream publishes.

## What it does

- **Provider route `loomy`** — the model catalog comes from the upstream `GET /api/v1/models`; only `protocol === 'openai_chat' && type === 'chat'` entries register (image models and `auto` are excluded — `auto` silently falls back to a paid model upstream). Names carry the upstream multiplier; context and output limits come from the catalog.
- **Multi-account** — every signed-in account becomes its own provider route (`loomy`, `loomy-2`, `loomy-3`, …): pick that route in the model picker to spend that account, so two conversations can use two accounts in parallel. Slot numbers are assigned once and never renumbered, so removing an account cannot silently rebind another one's selections to a different person's quota
- **Automatic rotation pool** (opt-in route `loomy-pool`) — offered once two accounts exist; each call picks a healthy account at random. A failure that means "don't use this one" (dead session, no credit, rate limit) benches it for a 10-minute cooldown and the next call skips it; a successful call clears the mark. Per-account routes remain, for "this conversation always spends this account"
- **Account export / import** — the account tab exports every account as one JSON bundle; paste it on another machine and sign in there without an SMS code. The bundle holds the session tokens themselves (equivalent to a password); the upstream issues them with a **14-day** lifetime, so a copied bundle lasts until the original session expires, and signing out on either side revokes it
- **In-plugin sign-in** (account tab) — log in with an SMS code straight from the settings card; the signing keys are decrypted at runtime from the local Loomy.app bundle (never stored, never logged), account sessions live in `accounts.json` (0600), and the desktop client's sign-in is used automatically while no plugin account exists
- **Settings section** (account / models / diagnostics) — phone and sign-in time (shown in full: this is local data), per-model enable with draft-then-save semantics, and a read-only diagnostics table that quotes the upstream error verbatim for bug reports.
- **Draft-then-save model selection** — refreshing the catalog lands names and multipliers immediately but never overwrites unsaved picks; saving hot-swaps the route's model set (emits `llm/models-updated`), no restart needed.
- **Read-only credits** — `balance`, `dailyBalance`, `availableBalance` plus the ledger, cached 60s host-side with single-flight; failures surface the upstream message and never fake a zero.
- **Composer readout** — `Loomy · 39,314` beside the model picker, only while the session is on the Loomy route (via the host's `modelSelection` projection). It shrinks instead of pushing the model name out.
- **CLI** — `status` / `doctor` with `--json`: account, catalog counts and upstream probes (phone shown in full; nothing goes to logs).

## Install (web profile)

Prerequisites: Node `^22.19.0 || >=24`, pnpm, Loomy desktop signed in at least once, DSH 0.2.2-rc.1.

```bash
# 1) build — dsh installs the repo itself, lib/ must exist
cd /path/to/dsh-connect-loomy
pnpm install
pnpm build

# 2) install (link: keeps it in sync with future builds — see below)
dsh plugin --profile web add link:/path/to/dsh-connect-loomy

# 3) verify the profile picked it up
node -e "const p=require(process.env.HOME+'/.dsh/profiles/web/package.json'); console.log(p.dependencies['dsh-connect-loomy'], p.dsh.profile.bundles.includes('dsh-connect-loomy'))"

# 4) composition check (no server started)
dsh --profile web --dump-config | grep -A2 -B2 dsh-connect-loomy

# 5) restart DSH — the host half loads at boot
```

### Why `link:` instead of `file:`

`file:` **copies** the package into the profile's `node_modules/`. Everything you rebuild afterwards never reaches the profile: the symptom is "changed code, restarted, refreshed — nothing happened, and the console is silent", which reads like a broken plugin but is just a stale snapshot.

`link:` creates a symlink; after `pnpm build`, restarting DSH picks the new build up. Check which one you have:

```sh
ls -ld ~/.dsh/profiles/web/node_modules/dsh-connect-loomy   # leading l = symlink
```

### Why a browser refresh is not enough

The host reads the client bundle (`lib/client.js`) **at boot**. After changing client code: `pnpm build` → restart DSH → refresh the browser. The client prints one mount line so you can tell which build is running:

```
[dsh-connect-loomy] client half loaded (settings-section+pill-near-model-v3+login-v4+multi-account-v5+transfer-v6): settings.section + composer readout
```

## CLI

```bash
node lib/bin.js status --json    # sign-in state + catalog + credits overview
node lib/bin.js doctor --json    # credential candidates + three upstream probes
```

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch; disabled registers no provider route |
| `baseURL` | `https://loomyad.xunfei.cn/api/v1` | Loomy platform API base |
| `loomyVersion` | `0.9.39` | `loomy-version` header on chat requests (not validated upstream) |
| `sessionTtlMs` | `5000` | desktop sign-in file re-read interval |
| `precheckTtlMs` | `60000` | sign-in precheck (`/user/identity`) result cache |
| `catalogTtlMs` | `600000` | model catalog cache (0 = refresh every read) |
| `creditsTtlMs` | `60000` | read-only credits cache |
| `creditsPageSize` | `20` (1–100) | ledger rows (server clamps at 100) |

All fields are `.volatile()`: a settings save applies without a restart.

## Upstream contract notes

- Platform endpoints (`/models`, `/points/records`, `/user/identity`) authenticate with a `token:` header; chat uses `Authorization: Bearer` — the two are not interchangeable.
- Failures arrive as **HTTP 200 + envelope** (`code`), so nothing may be classified by HTTP status.
- An unknown model id silently falls back upstream to the free default — the route therefore fails locally on ids outside its whitelist instead of sending them.
- `content: ""` with `finish_reason: "length"` is a legal length truncation (reasoning consumed the budget), not an empty response; a stream that ends without `finish_reason` is retried, not accepted.
- See [docs/loomy-upstream.md](docs/loomy-upstream.md) for the full measured contract.

## Development

```bash
pnpm install
pnpm check   # typecheck + build + test
```

Tests are offline (fixtures + loopback HTTP): no real upstream, no real credentials. `node --test "tests/**/*.test.mjs"` — Node 22.23.2's `--test` rejects a directory argument.

Key documents: [plugin contract](docs/dsh-plugin-contract.md) (with line-number citations into host 0.2.2-rc.1) · [upstream contract](docs/loomy-upstream.md) · [verification report](docs/verification-report.md) · [review](docs/review-host.md).

## Known limitations

- No automatic rotation or failover between accounts: a route is bound to one account, so which account pays is always the one you picked. Adding an account requires a fresh SMS code; there is no token import from another machine. Loomy has no daily check-in endpoint, so none is implemented.
- A real `web` profile mount and the browser card were not exercised during verification (isolated `DSH_HOME` runs covered installation; see docs/verification-report.md §9/§10).
- Non-stream JSON replies are not accepted by pi-ai's streaming channel; DSH always sends `stream: true`, so a JSON body classifies as retryable `TRANSPORT` (it neither hangs nor masquerades as success).
- Composer readout sits in `conversation.input.right` and is capped at 104px: the host swaps the model's text for an icon past its 560px container breakpoint, so the badge yields (ellipsis) rather than pushing the name out.

## License

MIT
