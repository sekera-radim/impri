/**
 * Lightweight output helpers — no external deps.
 * Tables, status badges, key display, age formatting.
 */

// ─── ANSI color codes ─────────────────────────────────────────────────────────

const NO_COLOR = !process.stdout.isTTY || process.env['NO_COLOR'] !== undefined

function c(code: number, text: string): string {
  if (NO_COLOR) return text
  return `\x1b[${code}m${text}\x1b[0m`
}

export const bold = (t: string) => c(1, t)
export const dim = (t: string) => c(2, t)
export const green = (t: string) => c(32, t)
export const red = (t: string) => c(31, t)
export const yellow = (t: string) => c(33, t)
export const cyan = (t: string) => c(36, t)
export const magenta = (t: string) => c(35, t)
export const blue = (t: string) => c(34, t)

// ─── Status badge ─────────────────────────────────────────────────────────────

export function statusBadge(status: string): string {
  switch (status) {
    case 'pending':   return yellow('pending')
    case 'approved':  return green('approved')
    case 'rejected':  return red('rejected')
    case 'expired':   return dim('expired')
    case 'executed':  return green('executed')
    case 'execute_failed': return red('execute_failed')
    default:          return status
  }
}

// ─── Age formatting ───────────────────────────────────────────────────────────

export function age(unixSecs: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSecs
  if (diff < 60)     return `${diff}s ago`
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// ─── Table renderer ───────────────────────────────────────────────────────────

export interface Column {
  header: string
  key: string
  /** Optional cell transformer */
  render?: (value: unknown, row: Record<string, unknown>) => string
  /** Minimum column width (defaults to header length) */
  minWidth?: number
}

export function renderTable(
  columns: Column[],
  rows: Record<string, unknown>[],
): string {
  if (rows.length === 0) return dim('  (no results)')

  // Compute cell strings first
  const cells: string[][] = rows.map(row =>
    columns.map(col => {
      const raw = row[col.key]
      if (col.render) return col.render(raw, row)
      return raw == null ? '' : String(raw)
    }),
  )

  // Strip ANSI for width calculation
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

  // Column widths
  const widths = columns.map((col, ci) => {
    const headerLen = stripAnsi(col.header).length
    const min = col.minWidth ?? 0
    const maxCell = Math.max(0, ...cells.map(row => stripAnsi(row[ci]).length))
    return Math.max(headerLen, min, maxCell)
  })

  const pad = (str: string, width: number): string => {
    const visible = stripAnsi(str).length
    return str + ' '.repeat(Math.max(0, width - visible))
  }

  const header = columns.map((col, ci) => bold(pad(col.header, widths[ci]))).join('  ')
  const divider = dim(widths.map(w => '-'.repeat(w)).join('  '))
  const dataRows = cells.map(row =>
    columns.map((_, ci) => pad(row[ci], widths[ci])).join('  '),
  )

  return [header, divider, ...dataRows].join('\n')
}

// ─── Key box (for newly created keys — shown exactly once) ───────────────────

export function keyBox(key: string): string {
  const label = '  API key (copy it now — not shown again)  '
  const border = '─'.repeat(label.length + 2)
  return [
    `┌${border}┐`,
    `│${label}│`,
    `│  ${bold(green(key))}${' '.repeat(Math.max(0, label.length - key.length - 2))}  │`,
    `└${border}┘`,
  ].join('\n')
}

// ─── Error printers ───────────────────────────────────────────────────────────

export function printError(msg: string): void {
  process.stderr.write(`${red('Error:')} ${msg}\n`)
}

export function printWarning(msg: string): void {
  process.stderr.write(`${yellow('Warning:')} ${msg}\n`)
}

export function ok(msg: string): void {
  process.stdout.write(`${green('✓')} ${msg}\n`)
}

// ─── JSON output ──────────────────────────────────────────────────────────────

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

export function printJsonLine(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + '\n')
}

// ─── Timestamp formatting ─────────────────────────────────────────────────────

export function fmtTs(unixSecs: number | undefined | null): string {
  if (unixSecs == null) return dim('—')
  return new Date(unixSecs * 1000).toISOString().replace('T', ' ').slice(0, 19)
}
