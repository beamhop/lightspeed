// @ts-check
import react from '@astrojs/react'
import starlight from '@astrojs/starlight'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'
import { apiSidebar, typedocPlugins } from './api.config.mjs'

const site = process.env.DOCS_SITE ?? 'https://beamhop.github.io'

export default defineConfig({
  site,
  base: '/lightspeed/',
  trailingSlash: 'ignore',
  vite: { plugins: [tailwindcss()] },
  integrations: [
    react(),
    starlight({
      title: 'Beamhop Lightspeed',
      description:
        'Peer-to-peer rooms for the web: typed protocols over WebRTC with Nostr signaling, plus a self-hostable relay with TURN.',
      logo: { src: './src/assets/bunny.svg', alt: 'Beamhop bunny' },
      favicon: '/bunny.svg',
      customCss: ['./src/styles/starlight.css'],
      components: {
        Header: './src/components/starlight/Header.astro',
        ThemeSelect: './src/components/starlight/ThemeSelect.astro',
      },
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        styleOverrides: {
          borderRadius: '0.75rem',
          borderColor: 'var(--border)',
          codeFontFamily: 'var(--font-mono)',
          uiFontFamily: 'var(--font-sans)',
        },
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/beamhop/lightspeed' }],
      editLink: { baseUrl: 'https://github.com/beamhop/lightspeed/edit/main/apps/docs/' },
      lastUpdated: false,
      plugins: typedocPlugins,
      sidebar: [
        {
          label: 'Get started',
          items: [
            { label: 'Five-minute room', slug: 'get-started' },
            { label: 'Add React', slug: 'get-started/react' },
          ],
        },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Relay operator manual', items: [{ autogenerate: { directory: 'relay' } }] },
        apiSidebar,
        { label: 'Protocol spec', slug: 'protocol' },
        { label: 'Troubleshooting', slug: 'troubleshooting' },
        { label: 'Changelog', slug: 'changelog' },
        {
          label: 'Live demo',
          link: '/demo/',
          attrs: { target: '_blank', rel: 'noopener' },
        },
      ],
    }),
  ],
})
