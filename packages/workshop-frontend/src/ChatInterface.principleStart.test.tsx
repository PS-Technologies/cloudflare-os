// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type * as Kumo from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AiChatHistoryPage, AiChatMessage, AiChatMetadata, Overseer } from '@gadgets/workshop-shared/api'

// Principle: a chat home's Ask Watts started (routes/start.tsx) keeps its question and Watts
// thinking on screen until the chat's history has loaded. The workspace editor forgets the start
// once the chat list has loaded, which can be before the history has, so the chat keeps its own.

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
// jsdom lays nothing out; the message list scrolls itself to the bottom on every render.
Element.prototype.scrollTo = () => {}

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal<typeof Kumo>(),
  useKumoToastManager: () => ({ add: () => {} }),
}))

vi.mock('./AuthContext', () => {
  const context = {
    authenticatedApi: { listGatekeeperVendors: async () => [] },
    currentUser: null,
  }
  return {
    useAuthenticatedApi: () => context,
    useOptionalAuthenticatedApi: () => null,
  }
})

import { deferred, makeOverseer, makeTestRoot } from './action-test-harness'
import ChatInterface from './ChatInterface'
import { clearPrincipleStart, recordPrincipleStart } from './principleStart'

const testRoot = makeTestRoot()

afterEach(() => {
  testRoot.cleanup()
  clearPrincipleStart('workspace')
  vi.restoreAllMocks()
})

const CHAT_ID = 3
const QUESTION = 'Summarize the LCRA T-FCC bid'
const ANSWER = 'The bid covers two substations.'

const message = (sequence: number, author: AiChatMessage['author'], text: string): AiChatMessage => ({
  chatId: CHAT_ID,
  sequence,
  timestamp: new Date(1700000000000 + sequence),
  author,
  type: 'message',
  message: text,
})

const metadata: AiChatMetadata = {
  id: CHAT_ID,
  title: 'LCRA bid',
  started: new Date(1700000000000),
  lastActive: new Date(1700000000000),
}

// Opens chat CHAT_ID of 'workspace' over a server whose history arrives when the test says.
async function openChat(history: Promise<AiChatHistoryPage>) {
  const server = makeOverseer()
  Object.assign(server.overseer as object, {
    getChatMessage: async () => null,
    getChatHistory: () => history,
    listChats: async () => [metadata],
    listModels: async () => [],
    onRpcBroken: () => {},
    subscribeToChat: () => ({ [Symbol.dispose]: () => {} }),
    viewChat: () => ({ [Symbol.dispose]: () => {} }),
  })
  await testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={server.overseer as RpcStub<Overseer>}
      selectedChatId={CHAT_ID}
      onNavigateToChat={() => {}}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      constrainChatWidth
      onOpenGadget={() => {}}
      outputOfWorkpiece={() => undefined}
    />,
  )
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [] })
}

const panel = () => document.querySelector('.chat-panel')!
const bubbles = () => [...panel().querySelectorAll('.bg-kumo-bubble-user')].map((el) => el.textContent)

it('keeps the question and Watts thinking in place of the history spinner, until the history replaces them', async () => {
  recordPrincipleStart({ id: 'workspace', chat: CHAT_ID, question: QUESTION })
  const history = deferred<AiChatHistoryPage>()
  await openChat(history.promise)
  // The editor forgets the start once the chat list has loaded; the history has not.
  clearPrincipleStart('workspace')
  await act(async () => {})

  expect(bubbles()).toEqual([QUESTION])
  expect(panel().textContent).toContain('Thinking')
  expect(panel().querySelector('[aria-busy="true"]')).not.toBeNull()
  expect(panel().querySelector('.animate-spin')).toBeNull()

  await history.resolve({
    messages: [
      message(0, { type: 'user', id: 'dev', name: 'Dev' }, QUESTION),
      message(1, { type: 'agent', id: 'model', name: 'Model' }, ANSWER),
    ],
  })

  expect(bubbles()).toEqual([QUESTION])
  expect(panel().textContent).toContain(ANSWER)
  expect(panel().querySelector('[aria-busy="true"]')).toBeNull()
  expect(panel().querySelector('.animate-spin')).toBeNull()
})

it('keeps the history spinner for any other chat', async () => {
  recordPrincipleStart({ id: 'workspace', chat: CHAT_ID + 1, question: QUESTION })
  const history = deferred<AiChatHistoryPage>()
  await openChat(history.promise)

  expect(panel().querySelector('.animate-spin')).not.toBeNull()
  expect(bubbles()).toEqual([])
  expect(panel().textContent).not.toContain('Thinking')
})
