/** @jsxImportSource preact */
import '@beamhop/ui/tokens.css'
import '@beamhop/ui/components.css'
import './app.css'
import { render } from 'preact'
import { App } from './App'

const root = document.getElementById('app')
if (root) render(<App />, root)
