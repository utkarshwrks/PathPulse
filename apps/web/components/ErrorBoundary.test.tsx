import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary from './ErrorBoundary';

/**
 * The error boundary.
 *
 * React unmounts the entire tree on an uncaught render error, so without this
 * a null dereference inside a debug panel blanks the screen mid-demo and takes
 * the working estimator with it. That is the one failure a judge cannot be
 * talked through.
 */

function Boom({ when = true }: { when?: boolean }) {
  if (when) throw new Error('kaboom');
  return <p>fine</p>;
}

beforeEach(() => {
  // React logs the caught error; the test output is not the place for it.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders its children when nothing is wrong', () => {
    render(
      <ErrorBoundary area="Test">
        <p>all good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeDefined();
  });

  it('★ contains a crash instead of unmounting the tree', () => {
    render(
      <div>
        <ErrorBoundary area="Debug panel">
          <Boom />
        </ErrorBoundary>
        <p>HUD still here</p>
      </div>,
    );
    expect(screen.getByText('HUD still here')).toBeDefined();
    expect(screen.getByText(/Debug panel stopped working/)).toBeDefined();
  });

  it('names the area, so a crash points at which part failed', () => {
    render(
      <ErrorBoundary area="Confidence ellipse">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Confidence ellipse stopped working/)).toBeDefined();
  });

  it('★ says navigation is unaffected, so the badge is not read as a total failure', () => {
    render(
      <ErrorBoundary area="Debug panel">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Navigation is unaffected/)).toBeDefined();
  });

  it('shows the message rather than swallowing it', () => {
    render(
      <ErrorBoundary area="Test">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('kaboom')).toBeDefined();
  });

  it('renders a custom fallback where a card would be worse than nothing', () => {
    // Map layers pass fallback={null}: an apology card floating over the map
    // is worse than the layer simply being absent.
    const { container } = render(
      <ErrorBoundary area="Trail" fallback={null}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.textContent).toBe('');
  });

  it('can be retried', () => {
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error('once');
      return <p>recovered</p>;
    }
    render(
      <ErrorBoundary area="Test">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/stopped working/)).toBeDefined();
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('recovered')).toBeDefined();
  });

  it('logs the crash for the console, since a silent panel looks unbuilt', () => {
    render(
      <ErrorBoundary area="Map">
        <Boom />
      </ErrorBoundary>,
    );
    expect(console.error).toHaveBeenCalled();
  });
});
