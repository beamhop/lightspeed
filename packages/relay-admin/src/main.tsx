import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { TooltipProvider } from './components/ui/tooltip'
import { setBase, startRouter } from './router'
import { applyTheme, storedTheme } from './settings'

setBase(import.meta.env.BASE_URL)
applyTheme(storedTheme())
startRouter()

const root = document.getElementById('app')
if (root)
  createRoot(root).render(
    <StrictMode>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </StrictMode>,
  )
