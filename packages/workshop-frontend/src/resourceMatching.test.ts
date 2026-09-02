import { describe, expect, it } from 'vitest'
import { normalizeResourceUrl } from './resourceMatching'

describe('normalizeResourceUrl', () => {
  it('prepends https:// to a schemeless host', () => {
    expect(normalizeResourceUrl('example.com/site')).toBe('https://example.com/site')
  })

  it('leaves http and https URLs alone', () => {
    expect(normalizeResourceUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(normalizeResourceUrl('http://example.com/a')).toBe('http://example.com/a')
  })

  it('leaves a vendor scheme alone instead of nesting it under https://', () => {
    expect(normalizeResourceUrl('proposal://workspace')).toBe('proposal://workspace')
  })

  it('strips a trailing /* wildcard', () => {
    expect(normalizeResourceUrl('example.com/site/*')).toBe('https://example.com/site')
    expect(normalizeResourceUrl('proposal://workspace/*')).toBe('proposal://workspace')
  })
})
