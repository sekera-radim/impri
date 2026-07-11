/**
 * Command-layer tests — mock the SDK client to verify each command
 * builds the right SDK call without network access.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ImpriClient } from '@impri/sdk'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ACT_ID = 'act_test001'

function pendingAction(id = ACT_ID) {
  return {
    id,
    kind: 'test.action',
    title: 'Test',
    status: 'pending' as const,
    preview: { format: 'plain' as const, body: 'hello' },
    editable: [] as string[],
    created_at: 1720000000,
    updated_at: 1720000000,
    expires_at: 1720086400,
    is_untrusted: false,
    decision: undefined as undefined,
  }
}

function approvedAction(id = ACT_ID) {
  return {
    ...pendingAction(id),
    status: 'approved' as const,
    decision: { verdict: 'approve' as const, decided_at: 1720003600 },
  }
}

function editableAction(id = ACT_ID) {
  return { ...pendingAction(id), editable: ['preview.body'] }
}

function createdAction(id = ACT_ID) {
  return {
    id,
    status: 'pending' as const,
    inbox_url: `https://app.impri.dev/inbox/${id}`,
    expires_at: 1720086400,
    created_at: 1720000000,
  }
}

function mockClient(overrides: Partial<ImpriClient> = {}): ImpriClient {
  return {
    createAction: vi.fn().mockResolvedValue(createdAction()),
    getAction: vi.fn().mockResolvedValue(pendingAction()),
    listActions: vi.fn().mockResolvedValue({ items: [pendingAction()], has_more: false }),
    decide: vi.fn().mockResolvedValue({
      id: ACT_ID, status: 'approved', verdict: 'approve',
      decided_at: 1720003600,
      final_preview: { format: 'plain', body: 'hello' },
    }),
    awaitDecision: vi.fn().mockResolvedValue(approvedAction()),
    listWatchers: vi.fn().mockResolvedValue({ items: [], has_more: false }),
    getWatcher: vi.fn(),
    deleteWatcher: vi.fn().mockResolvedValue(undefined),
    createWatcherFromPreset: vi.fn().mockResolvedValue({
      id: 'w_001', name: 'Test', kind: 'rss',
      schedule: { every: '1h' }, status: 'active',
      next_run_at: 1720000000,
      fail_count: 0, first_run_done: false,
      created_at: 1720000000, updated_at: 1720000000,
      config: {}, keywords: [], keywords_none: [], min_score: 1,
    }),
    listWatcherPresets: vi.fn().mockResolvedValue([
      {
        id: 'hn-front-page', title: 'HN Front Page',
        description: 'Monitor HN front page', category: 'Community',
        kind: 'rss', params: [], defaultScheduleEvery: '30m', buildNotes: '',
      },
    ]),
    listKeys: vi.fn().mockResolvedValue([]),
    createKey: vi.fn().mockResolvedValue({
      id: 'key_001', name: 'test', key: 'im_abcdef123456',
      prefix: 'im_abcd', scopes: ['actions'], project_id: 'proj_1',
      created_at: 1720000000, note: 'Copy this key now.',
    }),
    revokeKey: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn().mockResolvedValue({
      id: 'proj_1', name: 'Test Project', timezone: 'UTC', created_at: 1720000000,
    }),
    ...overrides,
  } as unknown as ImpriClient
}

// Silence stdout/stderr for all tests
function silenceOutput() {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
}

// ─── push command ─────────────────────────────────────────────────────────────

describe('push command', () => {
  beforeEach((): void => {
    vi.resetModules()
    vi.mock('../src/client-factory.js', () => ({ makeClient: vi.fn(), makeClientOptional: vi.fn() }))
    silenceOutput()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('calls createAction with kind and title', async () => {
    const { makeClient: mk } = await import('../src/client-factory.js')
    const client = mockClient()
    vi.mocked(mk).mockReturnValue(client)
    const { registerPush } = await import('../src/commands/push.js')
    const { Command } = await import('commander')
    const p = new Command()
    registerPush(p)

    await p.parseAsync(['node', 'impri', 'push', '--kind', 'db.exec', '--title', 'Run migration', '--body', 'SELECT 1'])

    expect(client.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'db.exec',
        title: 'Run migration',
        preview: expect.objectContaining({ body: 'SELECT 1' }),
      }),
    )
  })

  it('passes --format to preview', async () => {
    const { makeClient: mk } = await import('../src/client-factory.js')
    const client = mockClient()
    vi.mocked(mk).mockReturnValue(client)
    const { registerPush } = await import('../src/commands/push.js')
    const { Command } = await import('commander')
    const p = new Command()
    registerPush(p)

    await p.parseAsync(['node', 'impri', 'push', '--kind', 'x', '--title', 'y', '--body', 'z', '--format', 'markdown'])

    expect(client.createAction).toHaveBeenCalledWith(
      expect.objectContaining({ preview: expect.objectContaining({ format: 'markdown' }) }),
    )
  })

  it('calls awaitDecision when --wait is passed', async () => {
    const { makeClient: mk } = await import('../src/client-factory.js')
    const client = mockClient()
    vi.mocked(mk).mockReturnValue(client)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit:0') }) as never)

    const { registerPush } = await import('../src/commands/push.js')
    const { Command } = await import('commander')
    const p = new Command()
    registerPush(p)

    await expect(
      p.parseAsync(['node', 'impri', 'push', '--kind', 'x', '--title', 'y', '--body', 'z', '--wait']),
    ).rejects.toThrow('exit:0')

    expect(client.awaitDecision).toHaveBeenCalled()
  })
})

// ─── list / inbox commands ────────────────────────────────────────────────────

describe('list command', () => {
  beforeEach((): void => {
    vi.resetModules()
    vi.mock('../src/client-factory.js', () => ({ makeClient: vi.fn(), makeClientOptional: vi.fn() }))
    silenceOutput()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('list passes status filter', async () => {
    const { makeClient: mk } = await import('../src/client-factory.js')
    const client = mockClient()
    vi.mocked(mk).mockReturnValue(client)
    const { registerList } = await import('../src/commands/list.js')
    const { Command } = await import('commander')
    const p = new Command()
    registerList(p)

    await p.parseAsync(['node', 'impri', 'list', '--status', 'approved'])
    expect(client.listActions).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }))
  })

  it('inbox always passes status=pending', async () => {
    const { makeClient: mk } = await import('../src/client-factory.js')
    const client = mockClient()
    vi.mocked(mk).mockReturnValue(client)
    const { registerInbox } = await import('../src/commands/list.js')
    const { Command } = await import('commander')
    const p = new Command()
    registerInbox(p)

    await p.parseAsync(['node', 'impri', 'inbox'])
    expect(client.listActions).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }))
  })

  it('converts --since ISO date to unix timestamp', async () => {
    const { makeClient: mk } = await import('../src/client-factory.js')
    const client = mockClient()
    vi.mocked(mk).mockReturnValue(client)
    const { registerList } = await import('../src/commands/list.js')
    const { Command } = await import('commander')
    const p = new Command()
    registerList(p)

    await p.parseAsync(['node', 'impri', 'list', '--since', '2024-07-01T00:00:00Z'])
    expect(client.listActions).toHaveBeenCalledWith(
      expect.objectContaining({ since: Math.floor(Date.parse('2024-07-01T00:00:00Z') / 1000) }),
    )
  })
})

// ─── approve / reject commands ────────────────────────────────────────────────

describe('approve command', () => {
  beforeEach((): void => {
    vi.resetModules()
    vi.mock('../src/client-factory.js', () => ({ makeClient: vi.fn(), makeClientOptional: vi.fn() }))
    silenceOutput()
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('calls decide with verdict=approve', async () => {
    const { makeClient: mk } = await import('../src/client-factory.js')
    const client = mockClient()
    vi.mocked(mk).mockReturnValue(client)
    const { registerApprove } = await import('../src/commands/approve.js')
    const { Command } = await import('commander')
    const p = new Command()
    registerApprove(p)

    await expect(p.parseAsync(['node', 'impri', 'approve', ACT_ID])).rejects.toThrow('exit')
    expect(client.decide).toHaveBeenCalledWith(ACT_ID, 'approve', expect.objectContaining({ edited: undefined }))
  })

  it('fetches action and passes edited body when --edit is supplied', async () => {
    const { makeClient: mk } = await import('../src/client-factory.js')
    const client = mockClient({
      getAction: vi.fn().mockResolvedValue(editableAction()),
      decide: vi.fn().mockResolvedValue({
        id: ACT_ID, status: 'approved', verdict: 'approve',
        decided_at: 0, final_preview: { format: 'plain', body: 'edited' },
      }),
    })
    vi.mocked(mk).mockReturnValue(client)
    const { registerApprove } = await import('../src/commands/approve.js')
    const { Command } = await import('commander')
    const p = new Command()
    registerApprove(p)

    await expect(
      p.parseAsync(['node', 'impri', 'approve', ACT_ID, '--edit', 'new body']),
    ).rejects.toThrow('exit')
    expect(client.decide).toHaveBeenCalledWith(ACT_ID, 'approve', { edited: { 'preview.body': 'new body' } })
  })
})

describe('reject command', () => {
  beforeEach((): void => {
    vi.resetModules()
    vi.mock('../src/client-factory.js', () => ({ makeClient: vi.fn(), makeClientOptional: vi.fn() }))
    silenceOutput()
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('calls decide with verdict=reject', async () => {
    const { makeClient: mk } = await import('../src/client-factory.js')
    const client = mockClient()
    vi.mocked(mk).mockReturnValue(client)
    const { registerReject } = await import('../src/commands/approve.js')
    const { Command } = await import('commander')
    const p = new Command()
    registerReject(p)

    await expect(p.parseAsync(['node', 'impri', 'reject', ACT_ID])).rejects.toThrow('exit')
    expect(client.decide).toHaveBeenCalledWith(ACT_ID, 'reject')
  })

  it('exits 2 on ImpriConflict', async () => {
    // Import ImpriConflict from the same (fresh) module instance that the command will use
    // so that instanceof checks match across the module boundary.
    const { ImpriConflict: FreshConflict } = await import('@impri/sdk')
    const { makeClient: mk } = await import('../src/client-factory.js')
    const client = mockClient({
      decide: vi.fn().mockRejectedValue(new FreshConflict('Already decided', {})),
    })
    vi.mocked(mk).mockReturnValue(client)
    // Override exit to track the code
    vi.mocked(process.exit).mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`)
    }) as never)

    const { registerReject } = await import('../src/commands/approve.js')
    const { Command } = await import('commander')
    const p = new Command()
    registerReject(p)

    await expect(p.parseAsync(['node', 'impri', 'reject', ACT_ID])).rejects.toThrow('exit:2')
  })
})

// ─── watchers list ────────────────────────────────────────────────────────────

describe('watchers list', () => {
  beforeEach((): void => {
    vi.resetModules()
    vi.mock('../src/client-factory.js', () => ({ makeClient: vi.fn(), makeClientOptional: vi.fn() }))
    silenceOutput()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('calls listWatchers', async () => {
    const { makeClient: mk } = await import('../src/client-factory.js')
    const client = mockClient()
    vi.mocked(mk).mockReturnValue(client)
    const { registerWatchers } = await import('../src/commands/watchers.js')
    const { Command } = await import('commander')
    const p = new Command()
    registerWatchers(p)

    await p.parseAsync(['node', 'impri', 'watchers', 'list'])
    expect(client.listWatchers).toHaveBeenCalled()
  })
})

// ─── presets ──────────────────────────────────────────────────────────────────

describe('presets', () => {
  beforeEach((): void => {
    vi.resetModules()
    vi.mock('../src/client-factory.js', () => ({ makeClient: vi.fn(), makeClientOptional: vi.fn() }))
    silenceOutput()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('calls listWatcherPresets', async () => {
    const { makeClient: mk } = await import('../src/client-factory.js')
    const client = mockClient()
    vi.mocked(mk).mockReturnValue(client)
    const { registerPresets } = await import('../src/commands/presets.js')
    const { Command } = await import('commander')
    const p = new Command()
    registerPresets(p)

    await p.parseAsync(['node', 'impri', 'presets'])
    expect(client.listWatcherPresets).toHaveBeenCalled()
  })
})

// ─── keys ─────────────────────────────────────────────────────────────────────

describe('keys list', () => {
  beforeEach((): void => {
    vi.resetModules()
    vi.mock('../src/client-factory.js', () => ({ makeClient: vi.fn(), makeClientOptional: vi.fn() }))
    silenceOutput()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('calls listKeys', async () => {
    const { makeClient: mk } = await import('../src/client-factory.js')
    const client = mockClient()
    vi.mocked(mk).mockReturnValue(client)
    const { registerKeys } = await import('../src/commands/keys.js')
    const { Command } = await import('commander')
    const p = new Command()
    registerKeys(p)

    await p.parseAsync(['node', 'impri', 'keys', 'list'])
    expect(client.listKeys).toHaveBeenCalled()
  })
})
