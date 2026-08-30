'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Named in the fallback so a crash points at which part failed. */
  area: string;
  /**
   * Rendered instead of the default card. Use for a map layer or a panel,
   * where a full-screen apology would be worse than nothing at all.
   */
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one broken component from taking the whole app down.
 *
 * ★ THE ENGINE DOES NOT NEED THE UI ★
 * Navigation is the product; the map, the panels and the pitch screen are
 * presentation. React's default behaviour on an uncaught render error is to
 * unmount the entire tree — so a null dereference inside a debug panel would
 * blank the screen mid-demo and take the working estimator with it. That trade
 * is exactly backwards, and it is the one failure mode a judge cannot be
 * talked through.
 *
 * So each risky region is wrapped separately. A failed map layer costs the map
 * layer. The HUD, and the engine behind it, carry on.
 *
 * The error is shown rather than swallowed. A panel that silently renders
 * nothing is indistinguishable from a feature that was never built, and by
 * Golden Rule #8 it is better to say "this part broke" than to let someone
 * discover it themselves.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[pathpulse] ${this.props.area} crashed`, error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <div className="pointer-events-auto m-2 rounded-lg border border-red-500/40 bg-red-950/80 p-3 text-[11px] text-red-200 backdrop-blur">
        <p className="font-semibold">{this.props.area} stopped working</p>
        <p className="mt-1 font-mono text-[10px] leading-snug text-red-300/80">
          {error.message}
        </p>
        <p className="mt-1 text-[10px] text-red-300/60">
          Navigation is unaffected — this is presentation only.
        </p>
        <button
          type="button"
          onClick={this.reset}
          className="mt-2 rounded border border-red-400/40 px-2 py-1 text-[10px] text-red-100 transition hover:bg-red-500/20"
        >
          Try again
        </button>
      </div>
    );
  }
}
