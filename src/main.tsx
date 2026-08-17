/**
 * @file Web 应用入口：创建共享 Runtime 并挂载 React 根节点。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeFacade } from './runtime/core/runtime';
import { RuntimeProvider } from './runtime/react/runtime-react';
import { App } from './ui/App';
import './styles.css';

const runtime = new RuntimeFacade();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RuntimeProvider runtime={runtime}>
      <App />
    </RuntimeProvider>
  </StrictMode>,
);
