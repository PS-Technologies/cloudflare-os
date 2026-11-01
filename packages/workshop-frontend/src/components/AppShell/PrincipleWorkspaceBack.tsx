import { Link } from '@tanstack/react-router'
import { ArrowLeft } from '@phosphor-icons/react'

const PrincipleWorkspaceBack = () => (
  <Link
    to="/"
    aria-label="Back to Dispatch"
    className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
  >
    <ArrowLeft size={16} aria-hidden="true" />
    <span>Dispatch</span>
  </Link>
)

export default PrincipleWorkspaceBack
