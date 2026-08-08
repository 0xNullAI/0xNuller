import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

// 独立的 /lobby 整页路由已删除：房间列表现在是外壳侧边栏的一个分区，
// 不再需要靠整页跳转往返。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
