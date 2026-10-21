import './styles.css'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { TooltipProvider } from './components/ui/tooltip'

// No StrictMode: its double-run effects would join a shared room link twice.
const root = document.getElementById('app')
if (root) {
  createRoot(root).render(
    <TooltipProvider delayDuration={200}>
      <App />
    </TooltipProvider>,
  )
}
