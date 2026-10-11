import type { Checks, Pr, Tone } from '../types'

// Everything with no engine in it: which Bash lines mean "this session is
// babysitting PR N", and how one `gh pr view` answer reads as a band row.

export type Target = { repo: string; number: number }

// What `gh pr view --json FIELDS --jq JQ` prints: review bodies dropped, the
// last verdict-bearing review kept (COMMENTED and PENDING carry no verdict).
export const FIELDS =
  'title,state,isDraft,headRefOid,reviewDecision,mergeStateStatus,reviewRequests,statusCheckRollup,reviews'
export const JQ =
  '{title, state, isDraft, head: .headRefOid, merge: .mergeStateStatus,' +
  ' requested: [.reviewRequests[] | .login // .name],' +
  ' checks: [.statusCheckRollup[] | {name: (.name // .context), conclusion: (.conclusion // .state // "")}],' +
  ' last: ([.reviews[] | select(.state != "COMMENTED" and .state != "PENDING")] | last' +
  ' | if . then {by: .author.login, state, commit: .commit.oid} else null end)}'

export type Raw = {
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  head: string
  merge: string
  requested: string[]
  checks: Array<{ name: string; conclusion: string }>
  last: { by: string; state: string; commit: string } | null
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/
const REPO_FLAG = /(?:^|\s)(?:-R|--repo)[=\s]+["']?([\w.-]+\/[\w.-]+)/

// The three lines that mean babysitting: babysit's own watcher, a PR this
// session just opened (gh prints its URL), and a review (re-)request.
export function detect(command: string, stdout: string): Target[] {
  const out: Target[] = []

  for (const m of command.matchAll(/watch-review\.sh\s+["']?([\w.-]+\/[\w.-]+)["']?\s+(\d+)/g)) {
    out.push({ repo: m[1]!, number: Number(m[2]) })
  }

  if (/\bgh\s+pr\s+create\b/.test(command)) {
    const m = PR_URL.exec(stdout)
    if (m) out.push({ repo: m[1]!, number: Number(m[2]) })
  }

  for (const m of command.matchAll(/\bgh\s+pr\s+edit\b([^;&|]*)/g)) {
    const seg = m[1]!
    if (!/--add-reviewer\b/.test(seg)) continue
    const url = PR_URL.exec(seg)
    if (url) {
      out.push({ repo: url[1]!, number: Number(url[2]) })
      continue
    }
    const num = seg.split(/\s+/).map(t => t.replace(/["']/g, '')).find(t => /^#?\d+$/.test(t))
    const repo = REPO_FLAG.exec(seg)?.[1]
    if (num && repo) out.push({ repo, number: Number(num.replace('#', '')) })
  }

  const seen = new Set<string>()
  return out.filter(t => !seen.has(keyOf(t)) && seen.add(keyOf(t)))
}

// Lines after which a tracked PR has likely moved: look again.
export function isRefresh(command: string): boolean {
  return (
    /\bgit\b[^;&|]*\bpush\b/.test(command) ||
    /\bgh\s+pr\s+(edit|merge|comment|ready|update-branch|close|reopen)\b/.test(command) ||
    /requested_reviewers/.test(command)
  )
}

export function keyOf(t: Target): string {
  return `${t.repo.toLowerCase()}#${t.number}`
}

const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

export function summarize(raw: Raw): Pick<Pr, 'title' | 'state' | 'verdict' | 'checks' | 'merge' | 'head'> {
  const checks: Checks = { pass: 0, fail: 0, pending: 0, failing: [] }
  let reviewing = false
  for (const c of raw.checks ?? []) {
    const done = String(c.conclusion ?? '').toUpperCase()
    if (PASS.has(done)) checks.pass += 1
    else if (FAIL.has(done)) {
      checks.fail += 1
      checks.failing.push(c.name)
    } else {
      checks.pending += 1
      // \b: `cadre-review` is the bot; "Vercel Preview Comments" is not.
      if (/\breview/i.test(c.name)) reviewing = true
    }
  }
  return {
    title: raw.title,
    state: raw.state,
    head: raw.head.slice(0, 8),
    checks,
    merge: raw.merge === 'BEHIND' ? 'behind' : raw.merge === 'DIRTY' ? 'conflicts' : null,
    verdict: verdictOf(raw, reviewing),
  }
}

// A verdict counts only on the commit it reviewed: a push dismisses an
// approval, so a review of an older head reads as "new commits".
function verdictOf(raw: Raw, reviewing: boolean): { label: string; tone: Tone } {
  if (raw.state === 'MERGED') return { label: 'merged', tone: 'done' }
  if (raw.state === 'CLOSED') return { label: 'closed', tone: 'dim' }
  if (raw.isDraft) return { label: 'draft', tone: 'dim' }
  if (reviewing) return { label: 'bot reviewing', tone: 'wait' }

  const last = raw.last
  const requested = raw.requested ?? []
  if (last && last.commit === raw.head) {
    if (last.state === 'APPROVED') return { label: `approved by ${last.by}`, tone: 'good' }
    if (last.state === 'CHANGES_REQUESTED') return { label: `changes requested by ${last.by}`, tone: 'bad' }
  }
  if (last && last.commit !== raw.head) {
    return requested.includes(last.by)
      ? { label: `awaiting ${last.by}`, tone: 'wait' }
      : { label: `new commits, re-request ${last.by}`, tone: 'wait' }
  }
  if (requested.length) return { label: `awaiting ${requested.join(', ')}`, tone: 'wait' }
  return { label: 'no review yet', tone: 'dim' }
}
