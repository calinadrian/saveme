import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

document.documentElement.dataset.theme = window.saveme.initialTheme ?? 'dark'
window.saveme.onTheme?.(theme => { document.documentElement.dataset.theme = theme })

createRoot(document.getElementById('root')!).render(<App />)
