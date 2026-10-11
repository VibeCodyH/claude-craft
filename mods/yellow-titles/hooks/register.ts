import type { Register } from 'claude-code'

// Yellow titles: a reply line that carries **bold** is drawn by this mod, with
// the bold spans yellow; every other line goes to the engine's own Markdown,
// so code blocks, tables and plain paragraphs look exactly as before.
// Display only: the stored reply is untouched (ctrl+o shows it as written).

const TITLE = 'yellow'
const CODE = 'blueBright'
const BOLD = /\*\*[^*\n]+\*\*/
const LIST = /^(\s*)(\d+[.)]|[-*+])\s+(.*)$/

type Segment =
  | { kind: 'md'; lines: string[] }
  | { kind: 'row'; indent: number; marker: string | null; body: string }
  | { kind: 'gap' }

export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    const text = e.props.text
    if (!BOLD.test(text)) return next(e)

    const segments = split(text)
    if (!segments.some(s => s.kind === 'row')) return next(e)

    const { Box, Text, Markdown, Link } = $.ui.resolve(e)

    const inline = (body: string) => {
      const parts: unknown[] = []
      const re = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g
      let at = 0
      for (const m of body.matchAll(re)) {
        if (m.index! > at) parts.push(body.slice(at, m.index))
        if (m[1] !== undefined) parts.push(Text({ color: TITLE, bold: true, children: m[1] }))
        else if (m[2] !== undefined) parts.push(Text({ color: CODE, children: m[2] }))
        else parts.push(Link({ href: m[4] ?? '', children: [m[3] ?? ''] }))
        at = m.index! + m[0].length
      }
      if (at < body.length) parts.push(body.slice(at))
      return Text({ children: parts as never })
    }

    const children = segments.map((s, i) => {
      if (s.kind === 'gap') return Box({ key: `g${i}`, height: 1 })
      if (s.kind === 'md') {
        const pad = commonIndent(s.lines)
        const md = Markdown({ text: s.lines.map(l => l.slice(pad)).join('\n') })
        return pad > 0 ? Box({ key: `m${i}`, paddingLeft: pad, children: [md] }) : Box({ key: `m${i}`, children: [md] })
      }
      const row = [inline(s.body)]
      if (s.marker === null) return Box({ key: `r${i}`, paddingLeft: s.indent, children: row })
      return Box({
        key: `r${i}`,
        flexDirection: 'row',
        paddingLeft: s.indent,
        children: [Text({ children: `${s.marker} ` }), Box({ flexShrink: 1, children: row })],
      })
    })

    return Box({ flexDirection: 'column', children })
  })
}

// One pass over the reply: lines with bold (outside code fences and tables)
// become rows; runs of other lines become Markdown chunks; blank lines between
// them become one-row gaps.
function split(text: string): Segment[] {
  const out: Segment[] = []
  let md: string[] = []
  let fenced = false
  let pendingGap = false

  const flushMd = () => {
    while (md.length && (md[md.length - 1] ?? '').trim() === '') md.pop()
    if (md.length) out.push({ kind: 'md', lines: md })
    md = []
  }

  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const isTable = /^\s*\|/.test(line)
    const isHeading = /^\s*#/.test(line)

    if (!fenced && line.trim() === '') {
      if (md.length) md.push(line)
      else pendingGap = out.length > 0
      continue
    }

    if (fenced || isTable || isHeading || !BOLD.test(line)) {
      if (!md.length && pendingGap) out.push({ kind: 'gap' })
      pendingGap = false
      md.push(line)
      continue
    }

    const hadBlank = md.length > 0 && (md[md.length - 1] ?? '').trim() === ''
    flushMd()
    if (pendingGap || hadBlank) out.push({ kind: 'gap' })
    pendingGap = false

    const m = line.match(LIST)
    if (m) out.push({ kind: 'row', indent: (m[1] ?? '').length, marker: m[2] ?? null, body: m[3] ?? '' })
    else out.push({ kind: 'row', indent: line.length - line.trimStart().length, marker: null, body: line.trim() })
  }
  flushMd()
  return out
}

function commonIndent(lines: string[]): number {
  let min = Infinity
  for (const l of lines) {
    if (l.trim() === '') continue
    min = Math.min(min, l.length - l.trimStart().length)
  }
  return min === Infinity ? 0 : min
}
