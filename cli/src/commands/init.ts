import readline from 'node:readline'
import { Command } from 'commander'
import { ImpriClient, ImpriUnauthorized } from '@impri/sdk'
import { saveConfig, CONFIG_FILE } from '../config.js'
import { bold, green, red, yellow, cyan, printError, keyBox, ok } from '../output.js'

// ─── Interactive prompt helpers ───────────────────────────────────────────────

function prompt(question: string, defaultVal?: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const q = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `
    rl.question(q, answer => {
      rl.close()
      resolve(answer.trim() || defaultVal || '')
    })
  })
}

/**
 * Masked key input — prints '*' per character typed.
 * Falls back to plain readline on non-TTY (piped/CI environments).
 */
function promptKey(question: string): Promise<string> {
  return new Promise(resolve => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      // Non-interactive: read plainly without echoing the value.
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      rl.question(`${question}: `, answer => {
        rl.close()
        resolve(answer.trim())
      })
      return
    }

    process.stdout.write(`${question}: `)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    let input = ''

    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdin.removeListener('data', onData)
        process.stdout.write('\n')
        resolve(input)
        return
      }
      if (ch === '\x03') {
        // Ctrl-C
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdin.removeListener('data', onData)
        process.stdout.write('\n')
        process.exit(1)
      }
      if (ch === '\x7f' || ch === '\b') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1)
          process.stdout.write('\b \b')
        }
        return
      }
      input += ch
      process.stdout.write('*')
    }

    process.stdin.on('data', onData)
  })
}

function promptYN(question: string, defaultN = true): Promise<boolean> {
  return new Promise(resolve => {
    const hint = defaultN ? '[y/N]' : '[Y/n]'
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`${question} ${hint}: `, answer => {
      rl.close()
      const a = answer.trim().toLowerCase()
      if (a === 'y' || a === 'yes') resolve(true)
      else if (a === 'n' || a === 'no') resolve(false)
      else resolve(!defaultN) // default
    })
  })
}

// ─── Signup (cloud only) ─────────────────────────────────────────────────────

async function runSignup(baseUrl: string, projectName: string): Promise<string> {
  process.stdout.write('Creating a free project on Impri Cloud...\n')
  const res = await fetch(`${baseUrl}/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: projectName }),
  })

  if (!res.ok) {
    if (res.status === 404) {
      printError('ALLOW_SIGNUP is not enabled on this server. Visit https://app.impri.dev to sign up.')
      process.exit(1)
    }
    if (res.status === 503 || res.status === 429) {
      printError('Server is currently rate-limiting signups. Please try again in a moment or visit https://app.impri.dev.')
      process.exit(1)
    }
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (body['message'] ?? body['error'] ?? res.statusText) as string
    printError(`Signup failed (HTTP ${res.status}): ${msg}`)
    process.exit(1)
  }

  const data = await res.json() as { api_key?: string; key?: string }
  const key = data['api_key'] ?? data['key'] ?? ''
  if (!key || !key.startsWith('im_')) {
    printError('Server returned an unexpected response during signup.')
    process.exit(1)
  }
  return key
}

// ─── Seed demo actions ────────────────────────────────────────────────────────

async function seedDemo(client: ImpriClient, baseUrl: string): Promise<void> {
  process.stdout.write('\nSeeding demo actions...\n')
  try {
    const a1 = await client.createAction({
      kind: 'demo.email',
      title: 'Draft: Welcome new signup',
      preview: {
        format: 'markdown',
        body: '**To:** alice@example.com\n\nHi Alice,\n\nWelcome aboard! We\'re glad to have you.\n\nBest,\nThe team',
      },
      editable: ['preview.body'],
    })

    const a2 = await client.createAction({
      kind: 'demo.publish',
      title: 'Publish blog post: Getting started with Impri',
      preview: {
        format: 'plain',
        body: 'Scheduled publish at 2026-07-15 09:00 UTC.',
      },
    })

    const inboxBase = baseUrl.replace(/^https?:\/\/[^/]+/, '')
    process.stdout.write(`\n${green('Demo actions created:')}\n`)
    process.stdout.write(`  ${cyan(a1.id)}  demo.email    ${a1.inbox_url}\n`)
    process.stdout.write(`  ${cyan(a2.id)}  demo.publish  ${a2.inbox_url}\n`)
    process.stdout.write(`\nTry ${bold("'impri inbox'")} to see them, then ${bold("'impri approve <id>'")} or ${bold("'impri reject <id>'")}.\n`)
  } catch (err) {
    process.stdout.write(`${yellow('Warning:')} Could not seed demo actions: ${(err as Error).message}\n`)
  }
}

// ─── Core init flow ──────────────────────────────────────────────────────────

async function runInit(opts: {
  baseUrl?: string
  cloud?: boolean
  signup?: boolean
  name?: string
  demo?: boolean
}): Promise<void> {
  process.stdout.write(`${bold('Impri CLI')} — human-in-the-loop approval for AI agents\n\n`)

  // Step 2: base URL
  let baseUrl: string
  if (opts.cloud) {
    baseUrl = 'https://api.impri.dev'
  } else if (opts.baseUrl) {
    baseUrl = opts.baseUrl.replace(/\/+$/, '')
  } else {
    const raw = await prompt('API base URL', 'http://localhost:8484')
    baseUrl = raw.replace(/\/+$/, '')
  }

  // Step 3: cloud signup
  let signupKey: string | undefined
  if (opts.cloud && opts.signup) {
    const projectName = opts.name ?? (await prompt('Project name', 'My Project'))
    signupKey = await runSignup(baseUrl, projectName)
    process.stdout.write('\n' + keyBox(signupKey) + '\n')
    process.stdout.write(yellow('\nThis key will NOT be shown again — copy it now.\n'))
    await prompt('Press Enter once you have stored the key')
    process.stdout.write('\n')
  }

  // Step 4: collect API key — env var > signup flow > interactive prompt.
  // The IMPRI_API_KEY env var is the recommended non-interactive alternative to the prompt.
  let apiKey: string = process.env['IMPRI_API_KEY'] ?? signupKey ?? ''

  if (process.env['IMPRI_API_KEY']) {
    process.stdout.write(`Using API key from ${bold('IMPRI_API_KEY')} env var.\n`)
  }

  if (!apiKey) {
    let attempts = 0
    while (attempts < 3) {
      apiKey = await promptKey('API key (im_...)')
      if (apiKey && apiKey.startsWith('im_')) break
      attempts++
      if (attempts < 3) {
        printError("Keys begin with im_ — check your key.")
      }
    }
    if (!apiKey || !apiKey.startsWith('im_')) {
      printError('Too many failed attempts. Exiting.')
      process.exit(1)
    }
  }

  // Step 5: verify credentials (up to 3 attempts for key)
  let verifiedProject: { name: string } | null = null
  let keyAttempts = 0

  while (keyAttempts < 3) {
    let client: ImpriClient
    try {
      client = new ImpriClient({ apiKey, baseUrl })
    } catch {
      printError('Invalid configuration. Check the base URL.')
      process.exit(1)
    }

    try {
      verifiedProject = await client.getProject()
      break
    } catch (err) {
      if (err instanceof ImpriUnauthorized) {
        keyAttempts++
        printError('Key rejected by the server. Try copying the key again.')
        if (keyAttempts < 3) {
          apiKey = await promptKey('API key (im_...)')
        } else {
          printError('Too many failed attempts.')
          process.exit(1)
        }
        continue
      }
      // Network error
      printError(`Could not reach ${baseUrl}: ${(err as Error).message}`)
      const save = await promptYN('Save anyway?')
      if (!save) process.exit(1)
      break
    }
  }

  // Step 6: write config
  saveConfig({ base_url: baseUrl, api_key: apiKey })
  ok(`Config saved to ${CONFIG_FILE}`)

  // Step 7: success
  if (verifiedProject) {
    process.stdout.write(`Connected to project ${bold(green(`'${verifiedProject.name}'`))}\n`)
  }
  process.stdout.write(`\nRun ${bold("'impri inbox'")} to see pending actions, or ${bold("'impri push'")} to create one.\n`)

  // Step 8: demo mode
  if (opts.demo && verifiedProject) {
    const client = new ImpriClient({ apiKey, baseUrl })
    await seedDemo(client, baseUrl)
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerInit(program: Command): void {
  program
    .command('init')
    .description(
      'Interactive onboarding: configure base URL and API key. ' +
      'Supply the key via the interactive prompt, piped stdin, or IMPRI_API_KEY env var.',
    )
    .option('--base-url <url>', 'API base URL')
    .option('--cloud', 'Use https://api.impri.dev as base URL')
    .option('--signup', 'Create a free project (cloud only)')
    .option('--name <name>', 'Project name for signup')
    .option('--demo', 'Seed two sample actions after connecting')
    .action(async (opts: {
      baseUrl?: string; cloud?: boolean
      signup?: boolean; name?: string; demo?: boolean
    }) => {
      await runInit(opts)
    })
}

export function registerLogin(program: Command): void {
  program
    .command('login')
    .description(
      "Alias for 'impri init' — re-run onboarding to update credentials. " +
      'Supply the key via the interactive prompt, piped stdin, or IMPRI_API_KEY env var.',
    )
    .option('--base-url <url>', 'API base URL')
    .option('--cloud', 'Use https://api.impri.dev as base URL')
    .action(async (opts: { baseUrl?: string; cloud?: boolean }) => {
      await runInit(opts)
    })
}
