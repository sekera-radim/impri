import fs from 'node:fs'
import { Command } from 'commander'
import {
  ImpriRejected,
  ImpriTimeout,
  ImpriError,
} from '@impri/sdk'
import type { PreviewFormat } from '@impri/sdk'
import { makeClient } from '../client-factory.js'
import { bold, green, red, yellow, cyan, statusBadge, printError, printJson, fmtTs } from '../output.js'

export function registerPush(program: Command): void {
  program
    .command('push')
    .description('Create an action for human approval')
    .requiredOption('--kind <kind>', 'Action kind (e.g. db.exec, email.send)')
    .requiredOption('--title <title>', 'Short title describing the action')
    .option('--body <text>', 'Preview body text (reads stdin when omitted)')
    .option('--format <fmt>', 'Preview format: plain | markdown | diff', 'plain')
    .option('--editable <field>', 'Editable field (e.g. preview.body); repeatable', collect, [] as string[])
    .option('--target-url <url>', 'Link to the resource being acted upon')
    .option('--expires-in <seconds>', 'Seconds until the action expires', parseInt)
    .option('--wait', 'Poll until the human decides')
    .option('--timeout <seconds>', 'Timeout for --wait (default 300)', parseInt)
    .option('--json', 'Emit raw JSON output')
    .action(async (opts: {
      kind: string; title: string; body?: string; format: string
      editable: string[]; targetUrl?: string; expiresIn?: number
      wait?: boolean; timeout?: number; json?: boolean
    }) => {
      // Read body from --body or stdin
      let body = opts.body ?? ''
      if (!body) {
        if (!process.stdin.isTTY) {
          body = fs.readFileSync('/dev/stdin', 'utf8').trimEnd()
        }
      }

      const client = makeClient()

      const created = await client.createAction({
        kind: opts.kind,
        title: opts.title,
        preview: { format: opts.format as PreviewFormat, body },
        editable: opts.editable.length > 0 ? opts.editable : undefined,
        target_url: opts.targetUrl,
        expires_in: opts.expiresIn,
      }).catch(handleError)

      if (opts.json) {
        printJson(created)
        return
      }

      process.stdout.write(`${green('Action created')}\n`)
      process.stdout.write(`  ID:        ${bold(cyan(created.id))}\n`)
      process.stdout.write(`  Kind:      ${opts.kind}\n`)
      process.stdout.write(`  Title:     ${opts.title}\n`)
      process.stdout.write(`  Expires:   ${fmtTs(created.expires_at)}\n`)
      process.stdout.write(`  Inbox URL: ${created.inbox_url}\n`)

      if (created.duplicate_of) {
        process.stdout.write(`  ${yellow(`Duplicate of ${created.duplicate_of}`)}\n`)
      }

      if (!opts.wait) return

      process.stdout.write(`\nWaiting for decision on ${created.id}...\n`)
      try {
        const action = await client.awaitDecision(created.id, {
          timeoutS: opts.timeout ?? 300,
        })
        process.stdout.write(`\n${green('Approved')} by reviewer\n`)
        if (action.decision?.final_preview) {
          process.stdout.write(`  Final body: ${action.decision.final_preview.body}\n`)
        }
        process.exit(0)
      } catch (err) {
        if (err instanceof ImpriRejected) {
          process.stdout.write(`\n${red('Rejected')} by reviewer\n`)
          process.exit(1)
        }
        if (err instanceof ImpriTimeout) {
          process.stdout.write(`\n${yellow('Timed out')} — action is still pending.\n`)
          process.exit(1)
        }
        handleError(err)
      }
    })
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value]
}

function handleError(err: unknown): never {
  if (err instanceof ImpriError) {
    printError(err.message)
  } else {
    printError(String(err))
  }
  process.exit(1)
}
