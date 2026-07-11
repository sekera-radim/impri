import readline from 'node:readline'
import { Command } from 'commander'
import { ImpriError } from '@impri/sdk'
import type { WatcherStatus, WatcherKind } from '@impri/sdk'
import { makeClient } from '../client-factory.js'
import { bold, dim, cyan, green, red, yellow, renderTable, fmtTs, printError, printJson, Column } from '../output.js'

function watcherStatusBadge(status: string): string {
  switch (status) {
    case 'active':    return green('active')
    case 'paused':    return dim('paused')
    case 'degraded':  return red('degraded')
    default:          return status
  }
}

const WATCHER_COLUMNS: Column[] = [
  { header: 'ID', key: 'id', minWidth: 12 },
  { header: 'NAME', key: 'name', minWidth: 20 },
  { header: 'KIND', key: 'kind', minWidth: 14 },
  { header: 'STATUS', key: 'status', render: (v) => watcherStatusBadge(String(v)) },
  { header: 'SCHEDULE', key: 'schedule', render: (v) => (v as { every: string }).every },
  { header: 'FAILS', key: 'fail_count', render: (v) => Number(v) > 0 ? red(String(v)) : dim('0') },
  { header: 'NEXT RUN', key: 'next_run_at', render: (v) => fmtTs(v as number) },
]

export function registerWatchers(program: Command): void {
  // 'impri watchers' as top-level command grouping
  const watchersCmd = program
    .command('watchers')
    .description('Manage watchers')

  // impri watchers list
  watchersCmd
    .command('list')
    .description('List all watchers')
    .option('--status <status>', 'Filter: active|paused|degraded')
    .option('--kind <kind>', 'Filter: rss|reddit_search|url_diff')
    .option('--json', 'Emit raw JSON')
    .action(async (opts: { status?: string; kind?: string; json?: boolean }) => {
      const client = makeClient()

      const result = await client.listWatchers({
        status: opts.status as WatcherStatus | undefined,
        kind: opts.kind as WatcherKind | undefined,
      }).catch(handleError)

      if (opts.json) {
        printJson(result.items)
        return
      }

      if (result.items.length === 0) {
        process.stdout.write(dim('  No watchers found.\n'))
        return
      }

      process.stdout.write(renderTable(WATCHER_COLUMNS, result.items as unknown as Record<string, unknown>[]) + '\n')
    })

  // impri watchers get <id>
  watchersCmd
    .command('get <watcher-id>')
    .description('Fetch a single watcher with item count')
    .option('--json', 'Emit raw JSON')
    .action(async (watcherId: string, opts: { json?: boolean }) => {
      const client = makeClient()
      const watcher = await client.getWatcher(watcherId).catch(handleError)

      if (opts.json) {
        printJson(watcher)
        return
      }

      process.stdout.write(`${bold(cyan(watcher.id))}\n`)
      process.stdout.write(`  Name:       ${watcher.name}\n`)
      process.stdout.write(`  Kind:       ${watcher.kind}\n`)
      process.stdout.write(`  Status:     ${watcherStatusBadge(watcher.status)}\n`)
      process.stdout.write(`  Schedule:   ${watcher.schedule.every}`)
      if (watcher.schedule.window) process.stdout.write(` (window: ${watcher.schedule.window})`)
      process.stdout.write('\n')
      process.stdout.write(`  Item count: ${watcher.item_count}\n`)
      process.stdout.write(`  Fail count: ${watcher.fail_count}\n`)
      if (watcher.last_error) process.stdout.write(`  Last error: ${red(watcher.last_error)}\n`)
      process.stdout.write(`  Created:    ${fmtTs(watcher.created_at)}\n`)
      process.stdout.write(`  Last run:   ${fmtTs(watcher.last_run_at ?? null)}\n`)
      process.stdout.write(`  Next run:   ${fmtTs(watcher.next_run_at)}\n`)
    })

  // impri watchers delete <id>
  watchersCmd
    .command('delete <watcher-id>')
    .description('Permanently delete a watcher')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (watcherId: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const confirmed = await confirm(
          `Delete watcher ${watcherId}? This cannot be undone.`,
        )
        if (!confirmed) {
          process.stdout.write(dim('Cancelled.\n'))
          return
        }
      }

      const client = makeClient()
      await client.deleteWatcher(watcherId).catch(handleError)
      process.stdout.write(`${green('Deleted')} watcher ${watcherId}\n`)
    })

  // Also expose 'impri watch add' via a separate 'watch' command in the parent program.
  // The watch+add is registered separately by registerWatchAdd in presets.ts.
}

async function confirm(question: string): Promise<boolean> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`${question} [y/N]: `, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
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
