import readline from 'node:readline'
import { Command } from 'commander'
import { ImpriError } from '@impri/sdk'
import { makeClient } from '../client-factory.js'
import { bold, dim, cyan, green, renderTable, printError, printJson, Column } from '../output.js'

const PRESET_COLUMNS: Column[] = [
  { header: 'ID', key: 'id', minWidth: 18 },
  { header: 'CATEGORY', key: 'category', minWidth: 12 },
  { header: 'DESCRIPTION', key: 'description', minWidth: 30 },
  { header: 'SCHEDULE', key: 'defaultScheduleEvery', minWidth: 8 },
]

export function registerPresets(program: Command): void {
  const presetsCmd = program
    .command('presets')
    .description('List watcher preset templates')
    .option('--category <cat>', 'Filter by category')
    .option('--json', 'Emit raw JSON')
    .action(async (opts: { category?: string; json?: boolean }) => {
      const client = makeClient()
      let presets = await client.listWatcherPresets().catch(handleError)

      if (opts.category) {
        presets = presets.filter(p => p.category.toLowerCase() === opts.category!.toLowerCase())
      }

      if (opts.json) {
        printJson(presets)
        return
      }

      // Group by category
      const byCategory = new Map<string, typeof presets>()
      for (const p of presets) {
        const list = byCategory.get(p.category) ?? []
        list.push(p)
        byCategory.set(p.category, list)
      }

      for (const [cat, items] of byCategory) {
        process.stdout.write(`\n${bold(cyan(cat))}\n`)
        const rows = items.map(p => ({
          id: p.id,
          description: p.description,
          params: p.params.filter(x => x.required).map(x => x.name).join(', ') || '—',
          defaultScheduleEvery: p.defaultScheduleEvery,
        }))
        const cols: Column[] = [
          { header: 'ID', key: 'id', minWidth: 18 },
          { header: 'DESCRIPTION', key: 'description', minWidth: 35 },
          { header: 'REQUIRED PARAMS', key: 'params', minWidth: 15 },
          { header: 'DEFAULT SCHEDULE', key: 'defaultScheduleEvery', minWidth: 10 },
        ]
        process.stdout.write(renderTable(cols, rows as unknown as Record<string, unknown>[]) + '\n')
      }
    })
}

export function registerWatchAdd(watchCmd: Command): void {
  watchCmd
    .command('add <preset-id>')
    .description('Create a watcher from a named preset')
    .option('--param <key=value>', 'Preset param (repeatable)', collectParam, {} as Record<string, string>)
    .option('--name <name>', 'Override watcher name')
    .option('--schedule <every>', 'Override schedule, e.g. 1h')
    .option('--json', 'Emit raw JSON')
    .action(async (presetId: string, opts: {
      param: Record<string, string>; name?: string; schedule?: string; json?: boolean
    }) => {
      const client = makeClient()

      const watcher = await client.createWatcherFromPreset(
        presetId,
        Object.keys(opts.param).length > 0 ? opts.param : undefined,
        {
          name: opts.name,
          schedule: opts.schedule ? { every: opts.schedule } : undefined,
        },
      ).catch(handleError)

      if (opts.json) {
        printJson(watcher)
        return
      }

      process.stdout.write(`${green('Watcher created')}\n`)
      process.stdout.write(`  ID:       ${bold(cyan(watcher.id))}\n`)
      process.stdout.write(`  Name:     ${watcher.name}\n`)
      process.stdout.write(`  Kind:     ${watcher.kind}\n`)
      process.stdout.write(`  Schedule: ${watcher.schedule.every}\n`)
      if (watcher.next_run_at) {
        process.stdout.write(`  Next run: ${new Date(watcher.next_run_at * 1000).toISOString()}\n`)
      }
    })
}

function collectParam(value: string, prev: Record<string, string>): Record<string, string> {
  const idx = value.indexOf('=')
  if (idx < 0) return prev
  return { ...prev, [value.slice(0, idx)]: value.slice(idx + 1) }
}

function handleError(err: unknown): never {
  if (err instanceof ImpriError) {
    printError(err.message)
  } else {
    printError(String(err))
  }
  process.exit(1)
}
