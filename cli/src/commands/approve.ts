import { Command } from 'commander'
import { ImpriError, ImpriConflict, ImpriNotFound } from '@impri/sdk'
import { makeClient } from '../client-factory.js'
import { green, red, printError, printJson, ok } from '../output.js'

export function registerApprove(program: Command): void {
  program
    .command('approve <action-id>')
    .description('Approve an action')
    .option('--edit <new-body>', 'Replace the preview body before approving')
    .option('--json', 'Emit raw JSON')
    .action(async (actionId: string, opts: { edit?: string; json?: boolean }) => {
      const client = makeClient()

      // When --edit is supplied, verify the field is in the editable list first.
      let edited: Record<string, unknown> | undefined
      if (opts.edit !== undefined) {
        const action = await client.getAction(actionId).catch(handleError)
        if (!action.editable.includes('preview.body')) {
          printError("This action does not allow editing 'preview.body'.")
          process.exit(1)
        }
        edited = { 'preview.body': opts.edit }
      }

      const result = await client
        .decide(actionId, 'approve', { edited })
        .catch(handleError)

      if (opts.json) {
        printJson(result)
        return
      }

      ok(`Approved ${actionId}`)
      if (result.diff) {
        process.stdout.write(`  Diff applied: yes\n`)
      }
      process.exit(0)
    })
}

export function registerReject(program: Command): void {
  program
    .command('reject <action-id>')
    .description('Reject an action')
    .option('--json', 'Emit raw JSON')
    .action(async (actionId: string, opts: { json?: boolean }) => {
      const client = makeClient()

      try {
        const result = await client.decide(actionId, 'reject')

        if (opts.json) {
          printJson(result)
          return
        }

        process.stdout.write(`${red('Rejected')} ${actionId}\n`)
        process.exit(0)
      } catch (err) {
        if (err instanceof ImpriConflict) {
          printError(`Action ${actionId} is already decided (conflict).`)
          process.exit(2)
        }
        handleError(err)
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
