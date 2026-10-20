#!/usr/bin/env bun
export { defaultIo, type Io, run, studioEntry } from './cli'
export { scaffoldFiles } from './scaffold'

import { run } from './cli'

if (import.meta.main) {
  // Long-running commands (`beamhop relay`) keep the event loop alive after run() resolves.
  process.exitCode = await run(process.argv.slice(2))
}
