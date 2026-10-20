/** @jsxImportSource preact */
import './styles.css'
import { render } from 'preact'
import { App } from './App'
import { setBase, startRouter } from './router'
import { applyTheme, storedTheme } from './screens/Settings'

setBase(import.meta.env.BASE_URL)
applyTheme(storedTheme())
startRouter()

const root = document.getElementById('app')
if (root) render(<App />, root)
