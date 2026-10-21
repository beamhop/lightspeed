// Site-wide navigation shared by the header (landing and docs) and the phone menu.

export const GITHUB_URL = 'https://github.com/beamhop/lightspeed'

export interface NavLink {
  label: string
  /** Path below the site base, with a trailing slash. */
  href: string
  /** Path prefixes (below the base) that mark this link as the current section. */
  match: string[]
}

export const NAV_LINKS: NavLink[] = [
  {
    label: 'Docs',
    href: '/get-started/',
    match: ['/get-started/', '/guides/', '/protocol/', '/troubleshooting/', '/changelog/'],
  },
  { label: 'Concepts', href: '/concepts/identity/', match: ['/concepts/'] },
  { label: 'Relay', href: '/relay/install/', match: ['/relay/'] },
  { label: 'API', href: '/api/', match: ['/api/'] },
  { label: 'Demo', href: '/demo/', match: ['/demo/'] },
]

export function navActive(link: NavLink, pathname: string, base: string): boolean {
  const path = pathname.startsWith(base) ? pathname.slice(base.length) : pathname
  const withSlash = path.endsWith('/') ? path : `${path}/`
  return link.match.some((m) => withSlash.startsWith(m))
}
