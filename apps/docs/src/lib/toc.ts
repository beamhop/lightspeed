// Highlights the heading being read in every "On this page" list and drives the phone dropdown.

const HEADER_OFFSET = 56 + 48 + 24 // header + phone TOC bar + breathing room

function init() {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-bh-toc] a[href^="#"]')]
  if (!links.length) return
  const ids = [...new Set(links.map((a) => decodeURIComponent(a.hash.slice(1))))]
  const headings = ids
    .map((id) => document.getElementById(id))
    .filter((h): h is HTMLElement => h !== null)
  const labels = document.querySelectorAll<HTMLElement>('[data-bh-toc-current]')

  let frame = 0
  const update = () => {
    frame = 0
    let current = headings[0]
    const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 2
    if (atBottom) current = headings[headings.length - 1]
    else {
      for (const h of headings) {
        if (h.getBoundingClientRect().top - HEADER_OFFSET > 0) break
        current = h
      }
    }
    for (const a of links) {
      const on = decodeURIComponent(a.hash.slice(1)) === current?.id
      a.toggleAttribute('data-active', on)
      if (on) a.setAttribute('aria-current', 'true')
      else a.removeAttribute('aria-current')
    }
    const text = current?.id === '_top' ? '' : (current?.textContent?.trim() ?? '')
    for (const l of labels) l.textContent = text
  }
  addEventListener('scroll', () => (frame ||= requestAnimationFrame(update)), { passive: true })
  update()

  for (const details of document.querySelectorAll<HTMLDetailsElement>('[data-bh-toc-mobile]')) {
    const close = () => {
      details.open = false
    }
    details.querySelector('nav')?.addEventListener('click', (e) => {
      if ((e.target as Element).closest('a')) close()
    })
    document.addEventListener('click', (e) => {
      if (!details.contains(e.target as Node)) close()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && details.open) {
        close()
        details.querySelector('summary')?.focus()
      }
    })
  }
}

init()
