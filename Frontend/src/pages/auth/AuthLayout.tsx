import type { ReactNode } from 'react';
import { BrandMark, WatchScene } from '@/illustrations';

/** Two-panel layout for the pages you see before signing in: the illustrated side and the form. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth__art">
        <div className="row" style={{ position: 'relative', zIndex: 1 }}>
          <BrandMark size={42} />
          <div>
            <p className="brand__name">EbolaWatch Nigeria</p>
            <p className="brand__sub">Misinformation response</p>
          </div>
        </div>
        <div>
          <h2>Catch the rumour before it spreads.</h2>
          <p>
            Spot false Ebola claims as they appear, review them with your team, and answer with a clear,
            sourced message.
          </p>
        </div>
        <WatchScene />
      </div>
      <div className="auth__panel">
        <div className="auth__form">{children}</div>
      </div>
    </div>
  );
}
