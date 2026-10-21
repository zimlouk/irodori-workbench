import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import WorkbenchRoot from './WorkbenchRoot'
import './styles.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('找不到应用挂载节点。')
}

createRoot(rootElement).render(
  <StrictMode>
    <WorkbenchRoot />
  </StrictMode>,
)
