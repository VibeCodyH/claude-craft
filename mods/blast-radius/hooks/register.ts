import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Held } from '../types'

// Blast Radius: for a risky Bash call, works out what it would touch with the
// tools' own dry runs and shows it beside Claude Code's own approval dialog,
// which stays the one place the person approves or rejects. A second pair of
// eyes, not a permission system: it reads command text, so aliases, scripts and
// $(…) get past it, and it never answers or skips the approval. Hard blocks stay
// in settings hooks.

const PANE = 'blast-radius'
const held = atom({ plugin: 'blast-radius', key: 'held' } as const, null)
const LIST_MAX = 12

type Kind = 'rm' | 'reset' | 'clean' | 'push' | 'branch' | 'discard' | 'migrate'
export type Risk = { kind: Kind; label: string; dir: string | null; args: string[] }

export const register: Register = (on, options) => {
  const wrappers = new Set([...WRAPPERS, ...list(options?.wrappers)])
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const risk = classify(command, wrappers)
    if (risk === null) return next(e)

    const dir = risk.dir ?? (await $.session.cwd())
    const report = await measure($, risk, dir)
    // No focus: the approval dialog that follows owns the keys.
    const opened = await $.ui.open({ id: PANE, title: 'Blast Radius' })
    const shown = command.replace(/\s+/g, ' ').trim()
    await update($, held, () => ({
      command: shown,
      label: risk.label,
      dir,
      summary: report.summary,
      lines: report.lines.slice(0, LIST_MAX),
      more: Math.max(0, report.lines.length - LIST_MAX),
      where: opened.isPlaced ? ('pane' as const) : ('band' as const),
    }))

    // The approval (or the auto-mode decision) and the run happen in here.
    try {
      return await next(e)
    } finally {
      // Clear only our own report: a second risky call may have replaced it.
      const now = await read($, held)
      if (now?.command === shown) {
        await update($, held, () => null)
        if (opened.isPlaced) await $.ui.close({ id: PANE })
      }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const h = await read($, held)
    if (!h) return next(e)
    return view($, e, h)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const h = await read($, held)
    if (!h || h.where !== 'band' || e.props.hasSurvey) return next(e)
    const { Box } = $.ui.resolve(e)
    const mine = view($, e, h)
    const below = await next(e)
    return (below ? Box({ flexDirection: 'column', children: [mine, below] } as never) : mine) as RenderElement
  })
}

function view($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], h: Held): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const rows: unknown[] = [
    Text({ color: 'yellow', bold: true, children: `⚠ Blast Radius · ${h.label}` }),
    Box({ flexDirection: 'row', children: [Text({ dimColor: true, children: 'Command  ' }), Text({ bold: true, wrap: 'truncate-end', children: h.command })] }),
    Box({ flexDirection: 'row', children: [Text({ dimColor: true, children: 'Would    ' }), Text({ color: 'red', bold: true, children: h.summary })] }),
  ]
  if (h.lines.length) {
    rows.push(Box({ height: 1 }))
    for (const line of h.lines) rows.push(Text({ children: `  ${line}` }))
    if (h.more) rows.push(Text({ dimColor: true, children: `  …and ${h.more} more` }))
  }
  rows.push(Text({ dimColor: true, children: `In: ${h.dir}` }))
  rows.push(Text({ dimColor: true, children: 'Approve or reject it in the Claude Code prompt.' }))
  return Box({ key: 'blast-radius', flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, children: rows } as never) as RenderElement
}

// ---- what counts as risky ------------------------------------------------

// Prefixes skipped before reading the real command. Add your own (a wrapper
// script, a token proxy) with the `wrappers` option.
const WRAPPERS = ['sudo', 'nice', 'timeout', 'env', 'command']

function list(v: unknown): string[] {
  return String(v ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

export function classify(command: string, wrappers: Set<string> = new Set(WRAPPERS)): Risk | null {
  let dir: string | null = null
  for (const seg of command.split(/&&|\|\||;|\|/)) {
    let t = tokens(seg)
    while (t.length && (wrappers.has(t[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]!) || /^\d+[smh]?$/.test(t[0]!))) t = t.slice(1)
    if (!t.length) continue
    if (t[0] === 'cd' && t[1]) { dir = t[1]; continue }

    if (/db:migrate:prod/.test(seg)) return { kind: 'migrate', label: 'prod migration', dir, args: [] }

    if (t[0] === 'rm') {
      const flags = t.slice(1).filter(x => x.startsWith('-'))
      const recursive = flags.some(f => f === '--recursive' || /^-[^-]*[rR]/.test(f))
      const paths = t.slice(1).filter(x => !x.startsWith('-'))
      if (!recursive || !paths.length) continue
      if (paths.every(p => p.startsWith('/tmp/'))) continue
      return { kind: 'rm', label: 'rm -r', dir, args: paths }
    }

    if (t[0] === 'git') {
      let rest = t.slice(1)
      let gdir = dir
      while (rest[0] === '-C' && rest[1]) { gdir = rest[1]; rest = rest.slice(2) }
      const sub = rest[0]
      const args = rest.slice(1)
      if (sub === 'reset' && args.includes('--hard')) return { kind: 'reset', label: 'git reset --hard', dir: gdir, args }
      if (sub === 'clean' && args.some(a => a === '--force' || /^-[^-]*f/.test(a))) return { kind: 'clean', label: 'git clean', dir: gdir, args }
      if (sub === 'push' && args.some(a => a === '-f' || a === '--force' || a.startsWith('--force-with-lease') || a.startsWith('+'))) return { kind: 'push', label: 'force push', dir: gdir, args }
      if (sub === 'branch' && args.includes('-D')) return { kind: 'branch', label: 'git branch -D', dir: gdir, args }
      if ((sub === 'checkout' && args.includes('--') && args.includes('.')) || (sub === 'restore' && args.includes('.') && !args.includes('--staged'))) {
        return { kind: 'discard', label: `git ${sub} .`, dir: gdir, args }
      }
    }
  }
  return null
}

function tokens(seg: string): string[] {
  const out: string[] = []
  for (const m of seg.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

// ---- what it would touch (dry runs only) ---------------------------------

type Report = { summary: string; lines: string[] }

async function measure($: EngineInterface, risk: Risk, dir: string): Promise<Report> {
  const run = (argv: string[]) => $.process.run(argv, { cwd: dir, timeoutMs: 8000 }).catch(() => null)
  const out = async (argv: string[]) => {
    const r = await run(argv)
    return r && r.exitCode === 0 ? r.stdout.split('\n').filter(l => l.trim() !== '') : null
  }

  switch (risk.kind) {
    case 'rm': {
      const home = (await out(['printenv', 'HOME']))?.[0] ?? ''
      const lines: string[] = []
      let files = 0
      let kb = 0
      for (const raw of risk.args) {
        const p = raw.startsWith('~/') && home ? home + raw.slice(1) : raw
        if (/[*?[]/.test(p)) { lines.push(`${raw}  (glob, not measured)`); continue }
        const found = await out(['find', p, '-type', 'f'])
        if (found === null) { lines.push(`${raw}  (not found)`); continue }
        files += found.length
        const du = await out(['du', '-sk', p])
        kb += Number(du?.[0]?.split(/\s+/)[0] ?? 0)
        lines.push(...found.map(f => f.replace(dir.endsWith('/') ? dir : `${dir}/`, '')))
      }
      return { summary: `delete ${files} file${files === 1 ? '' : 's'} (${size(kb)})`, lines }
    }
    case 'reset':
    case 'discard': {
      const st = await out(['git', 'status', '--porcelain'])
      if (st === null) return { summary: 'touch a folder that is not a git repo', lines: [] }
      const tracked = st.filter(l => !l.startsWith('??'))
      return {
        summary: tracked.length ? `discard uncommitted changes in ${tracked.length} file${tracked.length === 1 ? '' : 's'}` : 'discard nothing (no uncommitted changes)',
        lines: tracked.map(l => l.trim()),
      }
    }
    case 'clean': {
      const flags = risk.args.filter(a => a.startsWith('-')).map(a => (a === '--force' ? '' : a.replace(/f/g, ''))).filter(a => a !== '' && a !== '-')
      const would = (await out(['git', 'clean', '-n', ...flags])) ?? []
      return { summary: `delete ${would.length} untracked path${would.length === 1 ? '' : 's'}`, lines: would.map(l => l.replace(/^Would remove /, '')) }
    }
    case 'push': {
      const lost = await out(['git', 'log', '--oneline', 'HEAD..@{u}'])
      if (lost === null) return { summary: 'force push (upstream unknown, could not measure)', lines: [] }
      return { summary: lost.length ? `overwrite ${lost.length} commit${lost.length === 1 ? '' : 's'} on the remote` : 'force push (no remote-only commits lost)', lines: lost }
    }
    case 'branch': {
      const name = risk.args.filter(a => !a.startsWith('-'))[0] ?? ''
      const unpushed = (await out(['git', 'log', '--oneline', name, '--not', '--remotes', '-n', '50'])) ?? []
      return { summary: unpushed.length ? `delete ${name} with ${unpushed.length} unpushed commit${unpushed.length === 1 ? '' : 's'}` : `delete ${name} (everything on it is pushed)`, lines: unpushed }
    }
    case 'migrate':
      return { summary: 'apply every pending migration to PRODUCTION', lines: ['Run db:preflight:prod first to see WILL APPLY.'] }
  }
}

function size(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${kb} KB`
}
