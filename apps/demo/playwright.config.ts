import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.DEMO_PORT ?? 4173)

export default defineConfig({
  testDir: './e2e',
  // `.e2e.ts` keeps these out of `bun test`, which would otherwise pick up `*.spec.ts`.
  testMatch: '**/*.e2e.ts',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/lightspeed/demo/`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
  ],
  webServer: {
    command: `bun run build && bunx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/lightspeed/demo/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
