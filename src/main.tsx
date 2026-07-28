import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { BrowserRouter } from './router';
import { StoryOpsProvider } from './state/StoryOpsProvider';
import './styles.css';

registerSW({
  immediate: true,
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent('storyops:update-ready'));
  },
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent('storyops:offline-ready'));
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <StoryOpsProvider>
        <App />
      </StoryOpsProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
