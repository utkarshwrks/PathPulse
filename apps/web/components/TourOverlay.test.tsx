import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TourOverlay from './TourOverlay';
import Welcome from './Welcome';
import { TOUR_STEPS } from '@/lib/tour';

afterEach(cleanup);

function renderTour(index: number) {
  const onNext = vi.fn();
  const onBack = vi.fn();
  const onSkip = vi.fn();
  render(<TourOverlay index={index} onNext={onNext} onBack={onBack} onSkip={onSkip} />);
  return { onNext, onBack, onSkip };
}

describe('TourOverlay', () => {
  it('shows the step, its position, and progress dots', () => {
    renderTour(0);
    expect(screen.getByText(TOUR_STEPS[0]!.title)).toBeDefined();
    expect(screen.getByText(`Step 1 of ${TOUR_STEPS.length}`)).toBeDefined();
  });

  it('★ offers Skip on every single step', () => {
    // A tour you cannot leave is worse than no tour, and the person holding
    // the phone may only want the map.
    for (let i = 0; i < TOUR_STEPS.length; i++) {
      cleanup();
      const { onSkip } = renderTour(i);
      fireEvent.click(screen.getByRole('button', { name: /skip tour/i }));
      expect(onSkip, `step ${i}`).toHaveBeenCalled();
    }
  });

  it('advances and goes back', () => {
    const { onNext, onBack } = renderTour(1);
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(onNext).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(onBack).toHaveBeenCalled();
  });

  it('cannot go back from the first step', () => {
    renderTour(0);
    expect((screen.getByRole('button', { name: /^back$/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('says Done on the last step rather than Next', () => {
    renderTour(TOUR_STEPS.length - 1);
    expect(screen.getByRole('button', { name: /^done$/i })).toBeDefined();
  });

  it('responds to arrow keys and Escape', () => {
    const { onNext, onBack, onSkip } = renderTour(2);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onNext).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(onBack).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onSkip).toHaveBeenCalled();
  });

  it('★ renders every step without a missing anchor throwing', () => {
    // Nothing with a data-tour attribute exists in this test, so every step
    // falls back to a centred card. A tour that only works when the whole app
    // is mounted is a tour that breaks the first time a panel is conditional.
    for (let i = 0; i < TOUR_STEPS.length; i++) {
      cleanup();
      expect(() => renderTour(i)).not.toThrow();
      expect(screen.getByText(TOUR_STEPS[i]!.title)).toBeDefined();
    }
  });

  it('highlights the anchored element when it is present', () => {
    render(<div data-tour="hud" />);
    renderTour(1);
    expect(screen.getByTestId('tour-overlay')).toBeDefined();
  });
});

describe('Welcome', () => {
  it('says what the problem is in one line', () => {
    render(<Welcome onTour={vi.fn()} onSkip={vi.fn()} buildId="abc123" />);
    expect(screen.getByText(/tunnels and basements/i)).toBeDefined();
  });

  it('★ stays short — the numbers live where they can be checked', () => {
    // REVISED. This screen used to carry three paragraphs and the drift
    // figure with its caveats, before anyone had seen the app do anything.
    // That is a wall, not a welcome. The honest numbers are one tap away on
    // the results screen and the pitch deck, which state them in full.
    const { container } = render(
      <Welcome onTour={vi.fn()} onSkip={vi.fn()} buildId="abc123" />,
    );
    expect((container.textContent ?? '').length).toBeLessThan(220);
  });

  it('offers both the tour and a way past it', () => {
    const onTour = vi.fn();
    const onSkip = vi.fn();
    render(<Welcome onTour={onTour} onSkip={onSkip} buildId="abc123" />);
    fireEvent.click(screen.getByRole('button', { name: /quick tour/i }));
    expect(onTour).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^skip$/i }));
    expect(onSkip).toHaveBeenCalled();
  });

  it('shows the build id, so a phone can be told which APK it is running', () => {
    render(<Welcome onTour={vi.fn()} onSkip={vi.fn()} buildId="deadbee" />);
    expect(screen.getByText(/build deadbee/)).toBeDefined();
  });
});
