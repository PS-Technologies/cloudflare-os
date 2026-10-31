import type { ReactNode } from 'react'
import PrincipleRail from '../PrincipleRail'

const PrincipleWorkspace = ({ children }: { children: ReactNode }) => (
        <div className="flex h-full min-h-0 bg-[var(--sidebar)]">
          <PrincipleRail />
          <main className="min-h-0 min-w-0 flex-1 md:m-2 md:ml-0 md:overflow-hidden md:rounded-[12px] md:border md:border-[var(--line)] md:bg-[var(--bg)]">
            {children}
          </main>
        </div>
)

export default PrincipleWorkspace
