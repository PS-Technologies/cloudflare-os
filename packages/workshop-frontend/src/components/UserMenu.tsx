import { useNavigate } from '@tanstack/react-router'
import { DropdownMenu, Tooltip } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../AuthContext'
import { GearSix } from '@phosphor-icons/react'
import { PANEL_BUTTON } from './AppShell/PanelToggle'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './menuStyles'

export default function UserMenu() {
  const { logout, isAdmin } = useAuthenticatedApi()
  const navigate = useNavigate()

  return (
    <DropdownMenu>
      <Tooltip content="Settings" side="bottom" render={<span className="inline-flex" />}>
        <DropdownMenu.Trigger
          render={<button type="button" className={PANEL_BUTTON} aria-label="Settings"><GearSix size={16} /></button>}
        />
      </Tooltip>
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/gatekeepers' })}
          className={MENU_ITEM}
        >
          Gatekeepers
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/profile' })}
          className={MENU_ITEM}
        >
          Profile
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/providers' })}
          className={MENU_ITEM}
        >
          Providers
        </DropdownMenu.Item>
        {isAdmin && (
          <DropdownMenu.Item
            onClick={() => navigate({ to: '/admin' })}
            className={MENU_ITEM}
          >
            Admin
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          variant="danger"
          onClick={logout}
          className={MENU_ITEM_DANGER}
        >
          Sign out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
