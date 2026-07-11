import { Command } from 'commander'
import { ImpriError } from '@impri/sdk'
import { makeClient } from '../client-factory.js'
import { dim, cyan, bold, statusBadge, age, printError, printJsonLine } from '../output.js'

export function registerTail(program: Command): void {
  program
    .command('tail')
    .description('Watch for new pending actions (Ctrl-C to exit)')
    .option('--kind <kind>', 'Filter by kind')
    .option('--interval <seconds>', 'Poll interval in seconds (min 5, default 10)', parseInt)
    .option('--json', 'Stream each new action as a JSON line')
    .action(async (opts: { kind?: string; interval?: number; json?: boolean }) => {
      const intervalSec = Math.max(5, opts.interval ?? 10)
      const client = makeClient()

      if (!opts.json) {
        process.stdout.write(dim(`Watching for pending actions (every ${intervalSec}s)... Ctrl-C to stop.\n\n`))
      }

      // Track the latest created_at we've seen to avoid reprinting.
      let latestSeenAt = Math.floor(Date.now() / 1000)

      const poll = async () => {
        try {
          const result = await client.listActions({
            status: 'pending',
            kind: opts.kind,
            since: latestSeenAt,
            limit: 50,
          })

          const newItems = result.items.filter(a => a.created_at > latestSeenAt)

          if (newItems.length > 0) {
            // Update the watermark to the newest item seen
            latestSeenAt = Math.max(...newItems.map(a => a.created_at))

            for (const action of newItems) {
              if (opts.json) {
                printJsonLine(action)
              } else {
                process.stdout.write(
                  `${bold(cyan(action.id))}  ${action.kind.padEnd(20)}  ${action.title.slice(0, 50).padEnd(50)}  ${age(action.created_at)}\n`,
                )
              }
            }
          }
        } catch (err) {
          if (!opts.json) {
            printError(`Poll error: ${(err as Error).message}`)
          }
        }
      }

      // Run immediately, then on interval
      await poll()

      const timer = setInterval(poll, intervalSec * 1000)

      // Clean exit on Ctrl-C
      process.on('SIGINT', () => {
        clearInterval(timer)
        if (!opts.json) process.stdout.write(dim('\nStopped.\n'))
        process.exit(0)
      })
    })
}
