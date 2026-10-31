// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Principle: Back can restore Dispatch from the browser's memory after another Principle app
// changed the shared `ps-theme` choice; the page must show that choice, not the one it was left in.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme } from './ThemeContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let seen: string | undefined

function Reader() {
  seen = useTheme().themeMode
  return null
}

function restore(persisted: boolean) {
  const event = new Event('pageshow') as PageTransitionEvent
  Object.defineProperty(event, 'persisted', { value: persisted })
  window.dispatchEvent(event)
}

beforeEach(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  document.cookie = 'ps-theme=light; Path=/'
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<ThemeProvider><Reader /></ThemeProvider>))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.cookie = 'ps-theme=; Max-Age=0; Path=/'
  vi.unstubAllGlobals()
})

it('rereads the shared choice when Back restores the page, without saving it back', async () => {
  expect(seen).toBe('light')
  document.cookie = 'ps-theme=charcoal; Path=/'
  const write = vi.spyOn(document, 'cookie', 'set')
  await act(async () => restore(true))
  expect(seen).toBe('charcoal')
  expect(document.documentElement.dataset).toMatchObject({ theme: 'charcoal', mode: 'dark' })
  expect(write).not.toHaveBeenCalled()
})

it('leaves a freshly loaded page to its first read', async () => {
  document.cookie = 'ps-theme=charcoal; Path=/'
  await act(async () => restore(false))
  expect(seen).toBe('light')
})
