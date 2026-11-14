#!/usr/bin/env node
/**
 * Submit the awesome-dsh-plugin registry entry as a pull request.
 *
 * Idempotent by design: it is meant to be re-run by a scheduled job, so every
 * step first asks whether the work already exists. A second run after a
 * successful first run must be a no-op, not a duplicate branch or a second PR.
 *
 * Auth: the GitHub token is read from the macOS keychain via
 * `git credential-osxkeychain` (the same credential `git push` already uses),
 * so nothing is stored in this file or in the environment.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin';
const OWNER = 'diudiu62';
const REPO = 'dsh-connect-loomy';
const FILE = `data/plugins/${OWNER}__${REPO}.yml`;
const BRANCH = `add-${REPO}`;
const REPO_AGE_HOURS = 24;

const here = dirname(fileURLToPath(import.meta.url));
const entryPath = join(here, '..', 'contrib', 'awesome-dsh-plugin-entry.yml');

function token() {
  const out = execFileSync('git', ['credential-osxkeychain', 'get'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const match = /^password=(.+)$/m.exec(out);
  if (!match) throw new Error('no github.com credential in the keychain');
  return match[1];
}

const TOKEN = token();

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'dsh-connect-loomy-submitter',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function log(message) {
  console.log(`[submit] ${message}`);
}

/** The entry body: the YAML without the local-only leading comment block. */
function entryBody() {
  const raw = readFileSync(entryPath, 'utf8');
  const lines = raw.split('\n');
  const firstData = lines.findIndex((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  if (firstData < 0) throw new Error('entry file has no data lines');
  return `${lines.slice(firstData).join('\n').trimEnd()}\n`;
}

async function repoAgeHours() {
  const { status, body } = await api(`/repos/${OWNER}/${REPO}`);
  if (status !== 200) throw new Error(`cannot read ${OWNER}/${REPO}: ${status}`);
  return { hours: (Date.now() - new Date(body.created_at).getTime()) / 3_600_000, createdAt: body.created_at };
}

async function existingPr() {
  const { body } = await api(
    `/repos/${UPSTREAM}/pulls?head=${OWNER}:${BRANCH}&state=all&per_page=10`,
  );
  if (!Array.isArray(body)) return null;
  return body.find((pr) => pr.head?.ref === BRANCH) ?? null;
}

async function upstreamDefaultBranch() {
  const { status, body } = await api(`/repos/${UPSTREAM}`);
  if (status !== 200) throw new Error(`cannot read ${UPSTREAM}: ${status}`);
  return body.default_branch;
}

async function upstreamFileSha(base) {
  const { status, body } = await api(`/repos/${UPSTREAM}/contents/${FILE}?ref=${base}`);
  return status === 200 ? body.sha : null;
}

async function ensureFork() {
  const { status, body } = await api(`/repos/${OWNER}/${UPSTREAM.split('/')[1]}`);
  if (status === 200) {
    log(`fork exists: ${body.full_name}`);
    return;
  }
  log('creating fork…');
  const created = await api(`/repos/${UPSTREAM}/forks`, { method: 'POST', body: JSON.stringify({}) });
  if (created.status !== 202 && created.status !== 201) {
    throw new Error(`fork failed: ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  }
  // GitHub returns 202 before the fork is readable; poll briefly.
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const probe = await api(`/repos/${OWNER}/${UPSTREAM.split('/')[1]}`);
    if (probe.status === 200) {
      log('fork ready');
      return;
    }
  }
  throw new Error('fork did not become readable in time');
}

async function main() {
  const age = await repoAgeHours();
  log(`repo created ${age.createdAt} (${age.hours.toFixed(2)}h old)`);

  const pr = await existingPr();
  if (pr) {
    log(`already submitted: PR #${pr.number} (${pr.state}) ${pr.html_url}`);
    return { done: true, pr: pr.html_url, note: 'already submitted' };
  }

  if (age.hours < REPO_AGE_HOURS) {
    const waitMs = (REPO_AGE_HOURS - age.hours) * 3_600_000;
    log(`too young by ${(waitMs / 3_600_000).toFixed(2)}h — not submitting`);
    return { done: false, note: 'repo younger than 24h', retryInMs: Math.ceil(waitMs) };
  }

  const base = await upstreamDefaultBranch();
  const already = await upstreamFileSha(base);
  if (already) {
    log(`entry already on ${base} (sha ${already.slice(0, 7)}) — nothing to do`);
    return { done: true, note: 'entry already upstream' };
  }

  await ensureFork();
  const fork = `${OWNER}/${UPSTREAM.split('/')[1]}`;

  // Branch off the upstream head so the PR contains exactly one added file.
  const ref = await api(`/repos/${UPSTREAM}/git/ref/heads/${base}`);
  if (ref.status !== 200) throw new Error(`cannot read ${UPSTREAM} head: ${ref.status}`);
  const baseSha = ref.body.object.sha;

  const branch = await api(`/repos/${fork}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: baseSha }),
  });
  if (branch.status !== 201) {
    // A leftover branch from an earlier attempt: reset it to the base commit.
    log(`branch exists (${branch.status}) — resetting to ${base}`);
    const reset = await api(`/repos/${fork}/git/refs/heads/${BRANCH}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: baseSha, force: true }),
    });
    if (reset.status !== 200) throw new Error(`cannot reset branch: ${reset.status}`);
  }

  const body = entryBody();
  const commit = await api(`/repos/${fork}/contents/${FILE}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Add ${OWNER}/${REPO}\n\nRegisters the Loomy desktop app's local sign-in session as a \`loomy\` provider.\nShares the provider id with 2239058652/dsh-loomy-connect, so the two cannot be\ninstalled together; this one adds the credits readout, the diagnostics table\nand the status/doctor CLI.`,
      content: Buffer.from(body, 'utf8').toString('base64'),
      branch: BRANCH,
    }),
  });
  if (commit.status !== 201 && commit.status !== 200) {
    throw new Error(`cannot write entry: ${commit.status} ${JSON.stringify(commit.body).slice(0, 200)}`);
  }
  log(`entry committed to ${fork}:${BRANCH}`);

  const description = [
    `Adds \`${OWNER}/${REPO}\` — registers the Loomy desktop app's locally signed-in chat models as a \`loomy\` provider in DSH.`,
    '',
    '**Overlap, disclosed up front.** This registers the same `loomy` provider id as the listed `2239058652/dsh-loomy-connect`, so the two cannot be installed side by side. This one differs by:',
    '',
    '- a read-only credits readout in the composer (`Loomy · <available>`), with the monthly/daily breakdown in its tooltip;',
    '- a settings section with account, per-model toggles and an upstream diagnostics table that quotes the platform error verbatim;',
    '- a `status` / `doctor` CLI with `--json`.',
    '',
    'If the overlap makes this a duplicate under the list rules, please say so and I will withdraw it rather than have you merge a redundant row.',
    '',
    '**Verified before submitting:**',
    '',
    '- `dsh.bundle` manifest present; `cordis.patch.yml` reachable on `main`;',
    '- a prebuilt tarball is attached to the `v0.1.0` release (asset name carries no version, so `latest/download/` cannot rot);',
    '- `peerDependencies` use ranges that actually match the prerelease host build — checked with `semver.satisfies` against `0.2.2-rc.1`, not by eye.',
    '',
    `CI cannot judge whether this duplicates an existing row, so that judgement is yours. Repository: https://github.com/${OWNER}/${REPO}`,
  ].join('\n');

  const created = await api(`/repos/${UPSTREAM}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: `Add ${OWNER}/${REPO}`,
      head: `${OWNER}:${BRANCH}`,
      base,
      body: description,
      maintainer_can_modify: true,
    }),
  });
  if (created.status !== 201) {
    throw new Error(`cannot open PR: ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
  }
  log(`PR opened: ${created.body.html_url}`);
  return { done: true, pr: created.body.html_url };
}

main()
  .then((result) => {
    log(`result: ${JSON.stringify(result)}`);
    if (result && result.retryInMs) process.exitCode = 75; // EX_TEMPFAIL: retry later
  })
  .catch((error) => {
    console.error(`[submit] failed: ${error.message}`);
    process.exitCode = 1;
  });
