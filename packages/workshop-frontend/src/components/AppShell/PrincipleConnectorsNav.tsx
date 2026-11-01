import { Plug } from '@phosphor-icons/react'
import SidebarItem from './SidebarItem'

const PrincipleConnectorsNav = ({ collapsed }: { collapsed: boolean }) => (
  <SidebarItem
    to="/gatekeepers"
    label="Connectors"
    icon={<Plug size={14} weight="regular" aria-hidden="true" />}
    collapsed={collapsed}
  />
)

export default PrincipleConnectorsNav
