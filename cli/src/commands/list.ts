import { Command } from 'commander'
import type { ActionStatus } from '@impri/sdk'
import { ImpriError } from '@impri/sdk'
import { makeClient } from '../client-factory.js'
import { renderTable, statusBadge, age, printError, printJsonLine, dim, Column } from '../output.js'

const ACTION_COLUMNS: Column[] = [
  { header: 'ID', key: 'id', minWidth: 12 },
  { header: 'KIND', key: 'kind', minWidth: 10 },
  { header: 'TITLE', key: 'title', minWidth: 20 },
  { header: 'STATUS', key: 'status', render: (v) => statusBadge(String(v)) },
  { header: 'AGE', key: 'created_at', render: (v) => age(Number(v)) },
]

export function registerList(program: Command): void {
  program
    .command('list')
    .description('List actions newest-first')
    .option('--status <status>', 'Filter by status: pending|approved|rejected|expired')
    .option('--kind <kind>', 'Filter by kind')
    .option('--since <iso-date>', 'Only actions created after this ISO date')
    .option('--q <search>', 'Full-text search across title and preview body')
    .option('--limit <n>', 'Max results', parseInt)
    .option('--json', 'Emit newline-delimited JSON')
    .action(async (opts: {
      status?: string; kind?: string; since?: string
      q?: string; limit?: number; json?: boolean
    }) => {
      const client = makeClient()

      let since: number | undefined
      if (opts.since) {
        const d = Date.parse(opts.since)
        if (isNaN(d)) {
          printError(`Invalid --since date: ${opts.since}`)
          process.exit(1)
        }
        since = Math.floor(d / 1000)
      }

      const result = await client.listActions({
        status: opts.status as ActionStatus | undefined,
        kind: opts.kind,
        since,
        q: opts.q,
        limit: opts.limit,
      }).catch(handleError)

      if (opts.json) {
        for (const action of result.items) printJsonLine(action)
        return
      }

      process.stdout.write(renderTable(ACTION_COLUMNS, result.items as unknown as Record<string, unknown>[]) + '\n')
      if (result.has_more) {
        process.stdout.write(dim(`\n  (more results available — use --limit or paginate with cursor)\n`))
      }
    })
}

export function registerInbox(program: Command): void {
  program
    .command('inbox')
    .description("Shorthand for 'impri list --status pending'")
    .option('--kind <kind>', 'Filter by kind')
    .option('--limit <n>', 'Max results', parseInt)
    .option('--json', 'Emit newline-delimited JSON')
    .action(async (opts: { kind?: string; limit?: number; json?: boolean }) => {
      const client = makeClient()

      const result = await client.listActions({
        status: 'pending',
        kind: opts.kind,
        limit: opts.limit,
      }).catch(handleError)

      if (opts.json) {
        for (const action of result.items) printJsonLine(action)
        return
      }

      if (result.items.length === 0) {
        process.stdout.write(dim('  Inbox is empty — no pending actions.\n'))
        return
      }

      process.stdout.write(renderTable(ACTION_COLUMNS, result.items as unknown as Record<string, unknown>[]) + '\n')
    })
}

function handleError(err: unknown): never {
  if (err instanceof ImpriError) {
    printError(err.message)
  } else {
    printError(String(err))
  }
  process.exit(1)
}
