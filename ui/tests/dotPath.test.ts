import { describe, it, expect } from 'vitest'
import { buildEditedPayload, getByDotPath } from '../src/utils/dotPath'

describe('buildEditedPayload', () => {
  it('returns payload with all valid keys', () => {
    const result = buildEditedPayload(
      { 'preview.body': 'new body text' },
      ['preview.body'],
    )
    expect(result).toEqual({ 'preview.body': 'new body text' })
  })

  it('throws when a key is not in the whitelist', () => {
    expect(() =>
      buildEditedPayload({ 'payload.secret': 'hacked' }, ['preview.body']),
    ).toThrow('not in editable whitelist')
  })

  it('includes the invalid key name in the error message', () => {
    expect(() =>
      buildEditedPayload({ 'payload.secret': 'x', 'preview.body': 'y' }, ['preview.body']),
    ).toThrow('payload.secret')
  })

  it('returns empty object for empty changes', () => {
    const result = buildEditedPayload({}, ['preview.body'])
    expect(result).toEqual({})
  })

  it('throws when whitelist is empty but changes provided', () => {
    expect(() =>
      buildEditedPayload({ 'preview.body': 'x' }, []),
    ).toThrow()
  })

  it('returns a new object (does not mutate input)', () => {
    const changes = { 'preview.body': 'hello' }
    const result = buildEditedPayload(changes, ['preview.body'])
    result['preview.body'] = 'mutated'
    expect(changes['preview.body']).toBe('hello')
  })

  it('handles multiple valid fields', () => {
    const result = buildEditedPayload(
      { 'preview.body': 'a', 'preview.format': 'markdown' },
      ['preview.body', 'preview.format'],
    )
    expect(result).toEqual({ 'preview.body': 'a', 'preview.format': 'markdown' })
  })
})

describe('getByDotPath', () => {
  it('retrieves a top-level value', () => {
    expect(getByDotPath({ foo: 'bar' }, 'foo')).toBe('bar')
  })

  it('retrieves a nested value via dot-path', () => {
    const obj = { preview: { body: 'hello', format: 'markdown' } } as Record<string, unknown>
    expect(getByDotPath(obj, 'preview.body')).toBe('hello')
  })

  it('returns undefined for missing path', () => {
    expect(getByDotPath({ foo: 'bar' }, 'baz.qux')).toBeUndefined()
  })

  it('returns undefined when intermediate segment is null', () => {
    const obj = { foo: null } as Record<string, unknown>
    expect(getByDotPath(obj, 'foo.bar')).toBeUndefined()
  })
})
