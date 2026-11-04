import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ApiError } from './api/client';
import { AuthProvider } from './auth/AuthProvider';
import { ToastProvider } from './components/feedback/Toast';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: true,
      // a 4xx is the server's final answer; only transient failures are worth retrying
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
