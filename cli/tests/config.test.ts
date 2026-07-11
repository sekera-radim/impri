import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// We test the real functions with a temp dir
import { saveConfig, loadConfig, resolveCredentials, redactKey, CONFIG_DIR, CONFIG_FILE } from '../src/config.js'

const ORIG_HOME = os.homedir()

describe('redactKey', () => {
  it('redacts a full key', () => {
    const redacted = redactKey('im_abc123def456')
    expect(redacted).toMatch(/^im_[a-z0-9]+\*{4}$/)
    expect(redacted).not.toContain('def456')
  })

  it('handles short keys gracefully', () => {
    const r = redactKey('im_x')
    expect(r).toContain('****')
  })

  it('handles empty string', () => {
    expect(redactKey('')).toBe('****')
  })
})

describe('saveConfig / loadConfig (temp dir)', () => {
  let tmpDir: string
  let origEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impri-cli-test-'))
    origEnv = { ...process.env }
    // Override HOME so the config module writes to our temp dir
    // We can't easily override CONFIG_FILE since it's module-level,
    // so we test saveConfig / loadConfig directly with a spy.
    vi.spyOn(fs, 'existsSync')
    vi.spyOn(fs, 'mkdirSync')
    vi.spyOn(fs, 'writeFileSync')
    vi.spyOn(fs, 'readFileSync')
    vi.spyOn(fs, 'chmodSync')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.env = origEnv
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('saveConfig calls writeFileSync with mode 0o600', () => {
    const mockExists = vi.mocked(fs.existsSync).mockReturnValue(true)
    const mockWrite = vi.mocked(fs.writeFileSync).mockImplementation(() => {})
    vi.mocked(fs.chmodSync).mockImplementation(() => {})

    saveConfig({ base_url: 'http://localhost:8484', api_key: 'im_testkey' })

    expect(mockWrite).toHaveBeenCalledOnce()
    const [, content, writeOpts] = mockWrite.mock.calls[0]
    expect(typeof content).toBe('string')

    // Verify the written JSON has the right shape
    const parsed = JSON.parse(content as string)
    expect(parsed.base_url).toBe('http://localhost:8484')
    expect(parsed.api_key).toBe('im_testkey')

    // Verify mode 0o600 is set
    expect(writeOpts).toMatchObject({ mode: 0o600 })
  })

  it('saveConfig creates dir with mode 0o700 when missing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const mockMkdir = vi.mocked(fs.mkdirSync).mockImplementation(() => undefined)
    vi.mocked(fs.writeFileSync).mockImplementation(() => {})
    vi.mocked(fs.chmodSync).mockImplementation(() => {})

    saveConfig({ base_url: 'http://localhost:8484', api_key: 'im_test' })

    expect(mockMkdir).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ mode: 0o700 }))
  })

  it('loadConfig returns null when file missing (ENOENT)', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw err })

    const result = loadConfig()
    expect(result).toBeNull()
  })

  it('loadConfig parses valid JSON', () => {
    const cfg = { base_url: 'https://api.impri.dev', api_key: 'im_xyz' }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cfg))

    const result = loadConfig()
    expect(result).toEqual(cfg)
  })

  it('loadConfig throws on non-ENOENT error', () => {
    const err = new Error('Permission denied')
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw err })

    expect(() => loadConfig()).toThrow('Permission denied')
  })
})

describe('resolveCredentials', () => {
  let origEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    origEnv = { ...process.env }
    vi.spyOn(fs, 'readFileSync')
    vi.spyOn(fs, 'existsSync')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.env = origEnv
  })

  it('prefers IMPRI_API_KEY env over config file', () => {
    process.env['IMPRI_API_KEY'] = 'im_envkey'
    process.env['IMPRI_BASE_URL'] = 'https://env.example.com'
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ base_url: 'http://file.example', api_key: 'im_filekey' }),
    )

    const creds = resolveCredentials()
    expect(creds.apiKey).toBe('im_envkey')
    expect(creds.baseUrl).toBe('https://env.example.com')
    expect(creds.keyFromEnv).toBe(true)
  })

  it('falls back to config file when env not set', () => {
    delete process.env['IMPRI_API_KEY']
    delete process.env['IMPRI_BASE_URL']
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ base_url: 'http://file.example', api_key: 'im_filekey' }),
    )

    const creds = resolveCredentials()
    expect(creds.apiKey).toBe('im_filekey')
    expect(creds.baseUrl).toBe('http://file.example')
    expect(creds.keyFromEnv).toBe(false)
  })

  it('returns null apiKey when neither env nor file has a key', () => {
    delete process.env['IMPRI_API_KEY']
    delete process.env['IMPRI_BASE_URL']
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw err })

    const creds = resolveCredentials()
    expect(creds.apiKey).toBeNull()
    expect(creds.baseUrl).toBe('http://localhost:8484')
  })

  it('strips trailing slashes from base URL', () => {
    delete process.env['IMPRI_API_KEY']
    delete process.env['IMPRI_BASE_URL']
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ base_url: 'http://localhost:8484/', api_key: 'im_k' }),
    )

    const creds = resolveCredentials()
    expect(creds.baseUrl).toBe('http://localhost:8484')
  })
})
