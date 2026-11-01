import { useOptionalAuthenticatedApi } from '../AuthContext'
import { useTheme } from '../ThemeContext'
import { resolveTheme } from '../theme'
import { AppRail } from '../principle-rail/app-rail'

/**
 * Principle: the rail every Principle app wears on its far left, with Dispatch selected. It is
 * @ps/ui's, copied byte for byte into `principle-rail/`. Its switch is the Workshop's one theme
 * switch, so it writes the `ps-theme` cookie the home page reads. `column` stands beside the page
 * from `md` up; `drawer` rides in the mobile drawer.
 */
const PrincipleRail = ({ variant = 'column' }: { variant?: 'column' | 'drawer' }) => {
  // Optional: the root shows it before sign-in, around home's Ask Watts question (principleStart.ts).
  const currentUser = useOptionalAuthenticatedApi()?.currentUser
  const { themeMode, setThemeMode } = useTheme()
  const rail = (
    <AppRail
      current="dispatch"
      me={currentUser ? { email: currentUser.id, name: currentUser.name } : undefined}
      theme={resolveTheme(themeMode)}
      onTheme={setThemeMode}
      variant={variant}
    />
  )
  if (variant === 'drawer') return rail
  // A wrapper hides it, because the rail's stylesheet is in no cascade layer and so outranks
  // Tailwind's `hidden`. Its z-index keeps the switch's tip over the sidebar and the rail under a
  // full-screen gadget or Browser pane (z-20).
  return <div className="relative z-10 hidden md:flex">{rail}</div>
}

export default PrincipleRail
