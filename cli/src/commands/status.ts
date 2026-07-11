import { Command } from 'commander'
import { ImpriClient, ImpriUnauthorized, ImpriError } from '@impri/sdk'
import { resolveCredentials, redactKey } from '../config.js'
import { bold, green, red, dim, printError, printJson, ok } from '../output.js'

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Verify active config and show connection info')
    .option('--json', 'Emit raw JSON')
    .action(async (opts: { json?: boolean }) => {
      const creds = resolveCredentials()

      if (!creds.apiKey) {
        printError("No API key configured. Run 'impri init' first, or set IMPRI_API_KEY.")
        process.exit(1)
      }

      const client = new ImpriClient({ apiKey: creds.apiKey, baseUrl: creds.baseUrl })

      // Check health first
      let healthy = false
      try {
        const res = await fetch(`${creds.baseUrl}/healthz`)
        healthy = res.ok
      } catch {
        // network unreachable
      }

      if (!healthy) {
        printError(`Server unreachable at ${creds.baseUrl}`)
        process.exit(1)
      }

      // Verify key + get project
      let project: { name: string; id: string } | null = null
      try {
        project = await client.getProject() as { name: string; id: string }
      } catch (err) {
        if (err instanceof ImpriUnauthorized) {
          printError('API key is invalid or lacks admin scope. Run \'impri login\' to update it.')
          process.exit(1)
        }
        printError(`Error: ${(err as Error).message}`)
        process.exit(1)
      }

      // Pending count
      let pendingCount = 0
      try {
        const result = await client.listActions({ status: 'pending', limit: 1 })
        // We don't get total count from the API — use has_more as indicator
        const first = await client.listActions({ status: 'pending', limit: 100 })
        pendingCount = first.items.length
        if (first.has_more) pendingCount = 100 // approximate
      } catch {
        // non-fatal
      }

      if (opts.json) {
        printJson({
          base_url: creds.baseUrl,
          key_prefix: redactKey(creds.apiKey),
          key_from_env: creds.keyFromEnv,
          project_name: project.name,
          project_id: project.id,
          pending_count: pendingCount,
        })
        return
      }

      ok(`Connected to ${bold(creds.baseUrl)}`)
      process.stdout.write(`  Project:  ${bold(project.name)} (${dim(project.id)})\n`)
      process.stdout.write(`  API key:  ${dim(redactKey(creds.apiKey))}`)
      if (creds.keyFromEnv) process.stdout.write(dim('  (from IMPRI_API_KEY env)'))
      process.stdout.write('\n')
      process.stdout.write(`  Pending:  ${pendingCount > 0 ? bold(String(pendingCount)) : dim('0')} action${pendingCount !== 1 ? 's' : ''} awaiting decision\n`)
    })
}
