import readline from 'node:readline'
import { Command } from 'commander'
import { ImpriError } from '@impri/sdk'
import type { KeyScope } from '@impri/sdk'
import { makeClient } from '../client-factory.js'
import { bold, dim, green, red, cyan, renderTable, fmtTs, printError, printJson, keyBox, Column } from '../output.js'

const KEY_COLUMNS: Column[] = [
  { header: 'ID', key: 'id', minWidth: 12 },
  { header: 'PREFIX', key: 'prefix', minWidth: 12 },
  { header: 'NAME', key: 'name', minWidth: 16 },
  { header: 'SCOPES', key: 'scopes', render: (v) => (v as string[]).join(',') },
  { header: 'CREATED', key: 'created_at', render: (v) => fmtTs(v as number) },
  { header: 'LAST USED', key: 'last_used_at', render: (v) => fmtTs(v as number | undefined) },
  { header: 'REVOKED', key: 'revoked', render: (v) => v ? red('yes') : dim('no') },
]

export function registerKeys(program: Command): void {
  const keysCmd = program
    .command('keys')
    .description('Manage API keys (requires admin scope)')

  // impri keys list
  keysCmd
    .command('list')
    .description('List all API keys for the project')
    .option('--json', 'Emit raw JSON')
    .action(async (opts: { json?: boolean }) => {
      const client = makeClient()
      const keys = await client.listKeys().catch(handleError)

      if (opts.json) {
        printJson(keys)
        return
      }

      if (keys.length === 0) {
        process.stdout.write(dim('  No keys found.\n'))
        return
      }

      process.stdout.write(renderTable(KEY_COLUMNS, keys as unknown as Record<string, unknown>[]) + '\n')
    })

  // impri keys create
  keysCmd
    .command('create')
    .description('Create a new API key (shown exactly once)')
    .requiredOption('--name <name>', 'Human-readable key name')
    .requiredOption('--scopes <scopes>', 'Comma-separated scopes: actions,watch,admin')
    .action(async (opts: { name: string; scopes: string }) => {
      const scopes = opts.scopes.split(',').map(s => s.trim()) as KeyScope[]
      const validScopes: KeyScope[] = ['actions', 'watch', 'admin']
      for (const s of scopes) {
        if (!validScopes.includes(s)) {
          printError(`Unknown scope '${s}'. Valid scopes: ${validScopes.join(', ')}`)
          process.exit(1)
        }
      }

      const client = makeClient()
      const created = await client.createKey(opts.name, scopes).catch(handleError)

      process.stdout.write('\n' + keyBox(created.key) + '\n')
      process.stdout.write(`\n  ${bold('Name:')}   ${created.name}\n`)
      process.stdout.write(`  ${bold('Prefix:')} ${created.prefix}\n`)
      process.stdout.write(`  ${bold('Scopes:')} ${created.scopes.join(', ')}\n\n`)
      process.stdout.write(`${created.note ?? 'The key value will not be shown again.'}\n`)
    })

  // impri keys revoke
  keysCmd
    .command('revoke <key-id>')
    .description('Revoke an API key permanently')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (keyId: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const confirmed = await confirm(`Revoke key ${keyId}? All subsequent requests with this key will fail 401.`)
        if (!confirmed) {
          process.stdout.write(dim('Cancelled.\n'))
          return
        }
      }

      const client = makeClient()
      await client.revokeKey(keyId).catch(handleError)
      process.stdout.write(`${green('Revoked')} key ${keyId}\n`)
    })
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
