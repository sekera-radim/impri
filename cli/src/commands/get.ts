import { Command } from 'commander'
import { ImpriError } from '@impri/sdk'
import { makeClient } from '../client-factory.js'
import { bold, dim, cyan, statusBadge, fmtTs, printError, printJson } from '../output.js'

export function registerGet(program: Command): void {
  program
    .command('get <action-id>')
    .description('Fetch a single action with full detail')
    .option('--json', 'Emit raw JSON')
    .action(async (actionId: string, opts: { json?: boolean }) => {
      const client = makeClient()

      const action = await client.getAction(actionId).catch(handleError)

      if (opts.json) {
        printJson(action)
        return
      }

      process.stdout.write(`${bold(cyan(action.id))}\n`)
      process.stdout.write(`  Kind:      ${action.kind}\n`)
      process.stdout.write(`  Title:     ${action.title}\n`)
      process.stdout.write(`  Status:    ${statusBadge(action.status)}\n`)
      process.stdout.write(`  Created:   ${fmtTs(action.created_at)}\n`)
      process.stdout.write(`  Expires:   ${fmtTs(action.expires_at)}\n`)

      if (action.target_url) {
        process.stdout.write(`  Target:    ${action.target_url}\n`)
      }

      if (action.editable.length > 0) {
        process.stdout.write(`  Editable:  ${action.editable.join(', ')}\n`)
      }

      process.stdout.write(`\n  ${bold('Preview')} (${action.preview.format})\n`)
      // Indent each line of the preview body
      const previewLines = action.preview.body.split('\n')
      for (const line of previewLines) {
        process.stdout.write(`  │ ${line}\n`)
      }

      if (action.decision) {
        const d = action.decision
        process.stdout.write(`\n  ${bold('Decision')}\n`)
        process.stdout.write(`  Verdict:   ${statusBadge(d.verdict === 'approve' ? 'approved' : 'rejected')}\n`)
        process.stdout.write(`  Decided:   ${fmtTs(d.decided_at)}\n`)
        if (d.final_preview) {
          process.stdout.write(`\n  ${bold('Final preview')} (${d.final_preview.format})\n`)
          for (const line of d.final_preview.body.split('\n')) {
            process.stdout.write(`  │ ${line}\n`)
          }
        }
        if (d.diff) {
          process.stdout.write(`\n  ${bold('Diff')}\n`)
          for (const line of d.diff.split('\n')) {
            process.stdout.write(`  │ ${line}\n`)
          }
        }
      }
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
