import {
  ArrowLeft,
  Blueprint,
  BookOpen,
  Compass,
  House,
  SidebarSimple,
  SquaresFour,
  Stack,
} from '@phosphor-icons/react'
import { useSiteName } from '../../ServerConfigContext'
import { useGatekeeperApps } from '../../useGatekeeperApps'
import SidebarItem from './SidebarItem'
import PrincipleSidebarTitle from './PrincipleSidebarTitle'
import {
  SidebarWorkspacesProvider,
  SidebarWorkspacesTools,
  SidebarWorkspacesLists,
} from './SidebarWorkspaces'
import { inNativeApp, returnToInstalls } from '../../features/native-app/nativeApp'

/**
 * The persistent left rail. Three pinned regions sandwich a single scrolling region of lists, so
 * the user can always reach Search, primary nav, and the bottom utility strip no matter how many
 * workspaces they have.
 *
 * Layout (top → bottom):
 *   • brand row                            pinned
 *   • primary nav (Home, Workspaces, …)    pinned
 *   • workspace tools (⌘K search)          pinned
 *   • Favorites / Recent workspaces        SCROLLS
 *   • utility strip (plug, avatar)         pinned
 */
export default function Sidebar({
  collapsed,
  mobile = false,
  onToggleCollapsed,
}: {
  collapsed: boolean
  mobile?: boolean
  onToggleCollapsed: () => void
}) {
  const siteName = useSiteName()
  // Gatekeeper-served management apps the user can reach now (one per gatekeeper that provides a UI
  // and is connected / enabled for everyone). Disabled or not-yet-connected ones aren't returned, so
  // they simply don't appear. The set is fully dynamic — no gatekeeper is hardcoded.
  const gatekeeperApps = useGatekeeperApps()

  return (
    <aside
      aria-label="Primary"
      className={[
        'flex h-full flex-col bg-[var(--sidebar)] px-2.5 pt-2.5 pb-3',
        collapsed ? 'w-[56px]' : 'w-[calc(min(320px,100vw)_-_68px)] md:w-[248px]',
        'shrink-0 transition-[width] duration-200 ease-out md:bg-transparent',
      ].join(' ')}
    >
      <PrincipleSidebarTitle siteName={siteName} collapsed={collapsed} mobile={mobile} onToggleCollapsed={onToggleCollapsed} />

      {/* Expand affordance when collapsed — placed just under the logo for discoverability. */}
      {collapsed && (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="mx-auto mt-2 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
        >
          <SidebarSimple size={15} className="rotate-180" />
        </button>
      )}

      <SidebarWorkspacesProvider>
        {/* Pinned top stack. shrink-0 keeps it from squishing when the lists below grow. */}
        <div className="flex shrink-0 flex-col gap-3 pt-3">
          {/* Primary nav */}
          <nav className="flex flex-col gap-0.5 px-2">
            <SidebarItem
              to="/"
              label="Home"
              icon={<House size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/workspaces"
              label="Workspaces"
              icon={<SquaresFour size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/blueprints"
              label="Blueprints"
              icon={<Blueprint size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/outputs"
              label="Outputs"
              icon={<Stack size={14} weight="regular" />}
              collapsed={collapsed}
            />
            {/* Gatekeeper management apps (e.g. the Context Library), listed dynamically. */}
            {gatekeeperApps.map((app) => {
              // Escape the icon URL for safe interpolation into a CSS url("…") string.
              const maskUrl = app.icon
                ? `url("${app.icon.url.replace(/[\\"]/g, '\\$&')}")`
                : undefined
              return (
              <SidebarItem
                key={app.id}
                to="/gatekeepers/$appId"
                params={{ appId: app.id }}
                label={app.title}
                icon={
                  maskUrl ? (
                    // Render the (monochrome) app icon as a CSS mask filled with the row's current
                    // text color, so it tints like the Phosphor icons — subtle by default, accent
                    // when active, darker on hover.
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 bg-current"
                      style={{
                        maskImage: maskUrl,
                        WebkitMaskImage: maskUrl,
                        maskRepeat: 'no-repeat',
                        WebkitMaskRepeat: 'no-repeat',
                        maskPosition: 'center',
                        WebkitMaskPosition: 'center',
                        maskSize: 'contain',
                        WebkitMaskSize: 'contain',
                      }}
                    />
                  ) : (
                    <BookOpen size={14} weight="regular" />
                  )
                }
                collapsed={collapsed}
              />
              )
            })}
            <SidebarItem
              to="/explore"
              label="Explore"
              icon={<Compass size={14} weight="regular" />}
              collapsed={collapsed}
            />
          </nav>

          {/* Workspace tools: search. Pinned so it's always reachable. */}
          <SidebarWorkspacesTools collapsed={collapsed} />
        </div>

        {/* Scrolling middle: only the Favorites / Recent workspaces / Recent blueprints lists.
            min-h-0 lets flex children compute scroll height correctly. */}
        <div className="sidebar-scroll mt-1 min-h-0 flex-1 overflow-y-auto">
          <SidebarWorkspacesLists collapsed={collapsed} />
        </div>
      </SidebarWorkspacesProvider>

      {inNativeApp() && (
        <button
          type="button"
          onClick={returnToInstalls}
          aria-label="Back to installs"
          className={[
            'flex min-h-11 shrink-0 items-center border-t border-kumo-line py-2 text-sm text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
            collapsed ? 'justify-center px-2' : 'gap-2 px-4',
          ].join(' ')}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {!collapsed && 'Back to installs'}
        </button>
      )}
    </aside>
  )
}
