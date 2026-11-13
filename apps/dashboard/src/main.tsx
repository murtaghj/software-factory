// Browser entry point. Configuration is fetched at start (config.json next to the page), so one
// build serves any environment and no address or client ID is baked into the bundle.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type AppConfig } from './app.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
const res = await fetch('./config.json', { cache: 'no-store' });
if (!res.ok) throw new Error('config.json is missing');
const config = await res.json() as AppConfig;
createRoot(root).render(
  <StrictMode>
    <App deps={{ config, storage: globalThis.sessionStorage, location: {
      get href() { return globalThis.location.href; },
      get hash() { return globalThis.location.hash; },
      assign: (url) => { globalThis.location.assign(url); },
      onHashChange: (listener) => { globalThis.addEventListener('hashchange', listener); return () => { globalThis.removeEventListener('hashchange', listener); }; },
      // Drops the sign-in response from the address bar and history.
      replaceHash: (hash) => { globalThis.history.replaceState(null, '', `${globalThis.location.pathname}${hash}`); },
    } }} />
  </StrictMode>,
);
