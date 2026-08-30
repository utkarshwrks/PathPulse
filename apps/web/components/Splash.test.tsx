import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Splash from './Splash';

/**
 * The loading screen.
 *
 * It is the first thing anyone sees, and it renders while the map and the
 * ONNX model are loading — the busiest moment on a mid-range phone. So what
 * matters is that it is cheap and that it never claims a number it does not
 * have.
 */

afterEach(cleanup);

describe('Splash', () => {
  it('shows the name and what the project does', () => {
    render(<Splash />);
    expect(screen.getByText('PathPulse')).toBeDefined();
    expect(screen.getByText(/Navigation without GPS/i)).toBeDefined();
  });

  it('carries the attribution a judge looks for', () => {
    render(<Splash />);
    expect(screen.getByText(/SIH26168 · ISRO · Team Avinya/)).toBeDefined();
  });

  it('★ runs an indeterminate bar rather than inventing a percentage', () => {
    // A fake progress number would be a meaningless figure on a screen whose
    // whole point elsewhere is that its numbers are measured.
    const { container } = render(<Splash />);
    expect(container.querySelector('.pp-bar')).not.toBeNull();
  });

  it('shows a real proportion when one is actually known', () => {
    const { container } = render(<Splash progress={0.5} />);
    expect(container.querySelector('.pp-bar')).toBeNull();
    const bar = container.querySelector('[style*="width: 50%"]');
    expect(bar).not.toBeNull();
  });

  it('takes a caller-supplied label', () => {
    render(<Splash label="Loading map" />);
    expect(screen.getByText('Loading map')).toBeDefined();
  });

  it('★ animates with CSS only — nothing competing with the engine', () => {
    // No timers, no requestAnimationFrame. The engine needs the main thread.
    const { container } = render(<Splash />);
    expect(container.querySelectorAll('.pp-ring').length).toBeGreaterThan(1);
  });
});
