import { Fragment, useState, type ReactNode } from 'react'
import styles from '../ChatInterface.module.css'
import PrincipleWorkspaceBack from './AppShell/PrincipleWorkspaceBack'
import { WorkshopButton } from './WorkshopControls'

// Principle: what a workspace looks like the moment home's Ask Watts question is sent: the question
// as the first message and Watts thinking. It copies the editor's frame (GadgetEditor.tsx) and the
// chat's markup (ChatInterface.tsx) class for class, so the workspace replaces it in place, and it
// draws nothing the workspace has not told us yet: no title, menus or composer.
// PrincipleStartFrame.test.tsx fails when either file drops a class copied here. It imports neither,
// because the root shows it before the workspace's code has loaded.

type StartChatProps = {
  /** The question, as the person asked it. */
  question: string
  /** The start has run long enough to say so. */
  slow?: boolean
  /** The start failed, and the frame offers to try again. */
  failed?: boolean
  onRetry?: () => void
}

/** Plain text as the chat's markdown shows it: paragraphs at blank lines, breaks at newlines. */
function QuestionText({ question }: { question: string }) {
  return question.split(/\n{2,}/).map((paragraph, index) => (
    <p key={index}>
      {paragraph.split('\n').map((line, at) => (
        <Fragment key={at}>{at > 0 && <br />}{line}</Fragment>
      ))}
    </p>
  ))
}

/** The chat's message column: the question as the first message, then Watts thinking. */
export function PrincipleStartMessages({ question, slow = false, failed = false, onRetry }: StartChatProps) {
  const [askedAt] = useState(() => new Date())
  return (
    <div className="flex flex-col px-3 pt-5 sm:px-6 sm:pt-8 pb-8 mx-auto w-full max-w-[920px]">
      <div className="group/message relative flex flex-col items-end">
        <div className={`themed-user-bubble-shadow w-fit max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg border border-transparent bg-kumo-bubble-user px-4 py-2.5 text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`}>
          <QuestionText question={question} />
        </div>
        <div className="mt-0.5 flex items-center justify-end gap-2 pr-1 text-[11px] leading-4 text-kumo-inactive opacity-100 transition-opacity duration-150 ease-out sm:opacity-0 sm:group-hover/message:opacity-100 sm:group-focus-within/message:opacity-100">
          <span className="font-mono">
            {askedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>
      <div className="group/agent min-w-0 w-full max-w-[860px] space-y-2 mt-5" aria-busy={!failed}>
        {failed ? (
          <>
            <p role="alert" className="px-1.5 py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-danger">
              {"Couldn't start this chat."}
            </p>
            <WorkshopButton tone="primary" onClick={onRetry}>Try again</WorkshopButton>
          </>
        ) : (
          <div className={`inline-flex px-1.5 py-1 text-[14px] leading-5 tracking-[-0.25px] ${styles.thinkingShimmer}`}>
            Thinking
          </div>
        )}
      </div>
      <p role="status" className="px-1.5 pt-1 text-[12px] leading-4 text-kumo-inactive">
        {slow && !failed ? 'Still starting' : null}
      </p>
    </div>
  )
}

/** The chat pane's part of the frame, filling the box ChatInterface fills. */
export function PrincipleStartChat(props: StartChatProps) {
  return (
    <div className="absolute inset-0 flex flex-col bg-kumo-base">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div aria-hidden="true" className="flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4" />
        <div className="chat-panel min-h-0 flex-1 overscroll-contain overflow-y-auto">
          <PrincipleStartMessages {...props} />
        </div>
      </div>
    </div>
  )
}

/** The workspace frame for a chat home's Ask Watts started: the editor's top bar and chat pane. */
export default function PrincipleStartFrame({ children, ...chat }: StartChatProps & { children?: ReactNode }) {
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-kumo-base">
      <div
        className="relative flex items-center justify-between px-4 sm:px-6 backdrop-blur-md border-b border-kumo-line flex-shrink-0 gap-3"
        style={{ height: 56, backgroundColor: 'color-mix(in srgb, var(--color-kumo-base) 80%, transparent)' }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <PrincipleWorkspaceBack />
          <span className="text-kumo-inactive flex-shrink-0">/</span>
        </div>
      </div>
      <div aria-hidden="true" className="flex h-12 shrink-0 items-center gap-1 border-b border-kumo-line bg-kumo-base px-2 md:hidden" />
      <div className="flex flex-1 min-h-0 relative overflow-hidden">
        <div className="flex flex-col flex-shrink-0 max-md:!w-full" style={{ width: '100%' }}>
          <div className="flex-1 min-h-0 relative">
            <PrincipleStartChat {...chat} />
          </div>
        </div>
      </div>
      {children}
    </div>
  )
}
