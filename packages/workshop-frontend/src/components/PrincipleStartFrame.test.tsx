// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Principle: the frame home's Ask Watts question shows in until its workspace opens. It copies the
// workspace's class names so the real one replaces it in place; these tests fail when either side
// drifts.

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import styles from '../ChatInterface.module.css'
import chatInterfaceSource from '../ChatInterface.tsx?raw'
import gadgetEditorSource from '../GadgetEditor.tsx?raw'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}))
vi.mock('./WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) =>
    <button type="button" {...props}>{children}</button>,
}))

import PrincipleStartFrame from './PrincipleStartFrame'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const QUESTION = 'Summarize the LCRA T-FCC bid'
const SOURCES: Record<string, string> = {
  'ChatInterface.tsx': chatInterfaceSource,
  'GadgetEditor.tsx': gadgetEditorSource,
}
const source = (file: string) => SOURCES[file]!

// Each class list the frame copies, and the file it copies it from.
const COPIED: Array<[file: string, classes: string]> = [
  ['GadgetEditor.tsx', 'relative flex h-full flex-col overflow-hidden bg-kumo-base'],
  ['GadgetEditor.tsx', 'relative flex items-center justify-between px-4 sm:px-6 backdrop-blur-md border-b border-kumo-line flex-shrink-0 gap-3'],
  ['GadgetEditor.tsx', 'flex min-w-0 flex-1 items-center gap-2'],
  ['GadgetEditor.tsx', 'text-kumo-inactive flex-shrink-0'],
  ['GadgetEditor.tsx', 'flex h-12 shrink-0 items-center gap-1 border-b border-kumo-line bg-kumo-base px-2 md:hidden'],
  ['GadgetEditor.tsx', 'flex flex-1 min-h-0 relative overflow-hidden'],
  ['GadgetEditor.tsx', 'flex flex-col flex-shrink-0 max-md:!w-full'],
  ['GadgetEditor.tsx', 'flex-1 min-h-0 relative'],
  ['ChatInterface.tsx', 'flex min-h-0 flex-1 flex-col overflow-hidden'],
  ['ChatInterface.tsx', 'flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4'],
  ['ChatInterface.tsx', 'chat-panel min-h-0 flex-1 overscroll-contain overflow-y-auto'],
  ['ChatInterface.tsx', 'flex flex-col px-3 pt-5 sm:px-6 sm:pt-8'],
  ['ChatInterface.tsx', 'mx-auto w-full max-w-[920px]'],
  ['ChatInterface.tsx', 'group/message relative flex flex-col items-end'],
  ['ChatInterface.tsx', 'themed-user-bubble-shadow w-fit max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg border border-transparent bg-kumo-bubble-user px-4 py-2.5 text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default'],
  ['ChatInterface.tsx', 'mt-0.5 flex items-center justify-end gap-2 pr-1 text-[11px] leading-4 text-kumo-inactive opacity-100 transition-opacity duration-150 ease-out sm:opacity-0 sm:group-hover/message:opacity-100 sm:group-focus-within/message:opacity-100'],
  ['ChatInterface.tsx', 'group/agent min-w-0 w-full max-w-[860px] space-y-2'],
  ['ChatInterface.tsx', 'inline-flex px-1.5 py-1 text-[14px] leading-5 tracking-[-0.25px]'],
]

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

function render(props: Partial<ComponentProps<typeof PrincipleStartFrame>> = {}) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(<PrincipleStartFrame question={QUESTION} {...props} />))
  return container
}

const withClasses = (page: HTMLElement, classes: string) =>
  [...page.querySelectorAll('*')].filter((el) => classes.split(' ').every((cls) => el.classList.contains(cls)))

it('draws the question and Watts thinking in the class names the workspace uses', () => {
  const page = render()

  const drifted = COPIED.filter(([file, classes]) =>
    !source(file).includes(classes) || withClasses(page, classes).length === 0)
  expect(drifted).toEqual([])
  // The pieces ChatInterface builds with its stylesheet: the bubble's markdown and the shimmer.
  const bubble = page.querySelector('.bg-kumo-bubble-user')!
  expect(source('ChatInterface.tsx')).toContain(
    `const userBubbleClassName = \`${bubble.className.replace(styles.markdownContent, '${styles.markdownContent}')}\``)
  expect(source('ChatInterface.tsx')).toMatch(
    /tracking-\[-0\.25px\] \$\{styles\.thinkingShimmer\}`\}>\s*Thinking\s*</)
  const thinking = withClasses(page, styles.thinkingShimmer)
  expect(thinking.map((el) => el.textContent)).toEqual(['Thinking'])
  // The chat's reply follows the person's message by the same gap it does in the workspace.
  expect(source('ChatInterface.tsx')).toMatch(/isUserMessageEntry\(lastEntry\)\s*\?\s*"mt-5"/)
  expect(thinking[0]!.parentElement!.classList.contains('mt-5')).toBe(true)
  // The editor's top bar height.
  expect(source('GadgetEditor.tsx')).toContain('const TOPBAR_H = 56')
  expect(withClasses(page, COPIED[1]![1])[0]!.getAttribute('style')).toContain('height: 56px')
  expect(page.querySelector('a[aria-label="Back to Dispatch"]')).not.toBeNull()
})

it('keeps the question\'s paragraphs and line breaks, as the chat shows them', () => {
  const page = render({ question: 'First line\nsecond line\n\nNext paragraph' })

  const paragraphs = [...page.querySelectorAll('.bg-kumo-bubble-user > p')]
  expect(paragraphs.map((p) => p.textContent)).toEqual(['First linesecond line', 'Next paragraph'])
  expect(paragraphs[0]!.querySelector('br')).not.toBeNull()
})

it('is busy while starting, and says when the start is slow', () => {
  let page = render()
  expect(page.querySelector('[aria-busy="true"]')?.textContent).toBe('Thinking')
  expect(page.querySelector('[role="status"]')?.textContent).toBe('')
  act(() => root!.unmount())

  page = render({ slow: true })
  expect(page.querySelector('[role="status"]')?.textContent).toBe('Still starting')
  expect(page.textContent).toContain('Thinking')
})

it('announces a failed start and offers to try again', () => {
  const onRetry = vi.fn<() => void>()
  const page = render({ failed: true, slow: true, onRetry })

  expect(page.querySelector('[role="alert"]')?.textContent).toBe("Couldn't start this chat.")
  expect(page.querySelector('[aria-busy="true"]')).toBeNull()
  expect(page.textContent).not.toContain('Thinking')
  expect(page.textContent).not.toContain('Still starting')
  expect(page.querySelector('.bg-kumo-bubble-user')?.textContent).toBe(QUESTION)
  act(() => page.querySelector('button')!.click())
  expect(onRetry).toHaveBeenCalledTimes(1)
})
