import '@beamhop/ui/tokens.css'
import './styles.css'
import { render } from 'preact'
import { App } from './app'

const root = document.getElementById('app')
if (root) render(<App />, root)
