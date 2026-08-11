import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

// The standalone full-page /lobby route has been deleted: the room list is now a
// section of the shell sidebar, so there is no need to round-trip through a
// full-page navigation any more.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
