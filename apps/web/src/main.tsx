import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './shell.css';
import { Shell } from './Shell';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
