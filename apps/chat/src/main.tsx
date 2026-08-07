import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { Lobby } from './components/Lobby'

// 轻量路径路由（不引 react-router）：/lobby 为独立大厅页，其余为主应用。
const isLobby = window.location.pathname === '/lobby'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isLobby ? <Lobby /> : <App />}
  </StrictMode>,
)
