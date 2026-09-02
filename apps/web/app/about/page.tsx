'use client';

import Link from 'next/link';
import DownloadApk from '@/components/DownloadApk';

/**
 * The public landing page.
 *
 * ★ WHY IT LIVES AT /about AND NOT AT / ★
 * The Capacitor APK wraps `out/` and opens `index.html`, so the root route has
 * to remain the application. Putting the landing page there would ship an
 * installed app that opens on a brochure.
 *
 * ★ WHAT THIS PAGE IS FOR ★
 * Someone arrives from a QR code on a slide, a link in a submission, or a
 * judge's browser. They have thirty seconds and no context. The page has to
 * say what the thing is, prove it was measured rather than asserted, and hand
 * over the app — in that order.
 *
 * The tone is deliberately the same as the rest of the project: numbers with
 * their caveats attached, and the limitations printed in the same size as the
 * results. A landing page that claims more than the benchmarks support would
 * be the one place the project lies about itself, and it is the first thing
 * anyone reads.
 */
export default function About() {
  return (
    <main className="min-h-screen bg-[#05070b] text-neutral-300">
      <Hero />
      <Problem />
      <HowItWorks />
      <Results />
      <Ai />
      <Deliverables />
      <Honest />
      <Get />
      <Footer />
    </main>
  );
}

/* ------------------------------------------------------------------- hero */

function Hero() {
  return (
    <header className="relative overflow-hidden border-b border-white/[0.06]">
      {/* The same motif the splash uses: a position broadcast, and lost. */}
      <div className="pp-splash-glow pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/3" />
      <div className="relative mx-auto max-w-3xl px-6 py-20 sm:py-28">
        <p className="pp-fade text-[10.5px] font-medium uppercase tracking-[0.2em] text-sky-400/80">
          Smart India Hackathon 2026 · SIH26168 · ISRO
        </p>
        <h1 className="pp-fade pp-delay-1 mt-5 text-[2.6rem] font-bold leading-[1.05] tracking-tight text-white sm:text-[3.4rem]">
          Navigation that does not stop
          <br />
          <span className="text-sky-400">when the satellites do.</span>
        </h1>
        <p className="pp-fade pp-delay-2 mt-6 max-w-xl text-[15px] leading-relaxed text-neutral-400">
          In a tunnel, a basement car park, or between tall buildings, GNSS
          disappears and the blue dot freezes or scatters. PathPulse keeps it
          moving — estimating vehicle motion from the phone&rsquo;s own inertial
          sensors, constraining it with vehicle physics and road geometry, and
          sliding it back onto truth when satellites return.
        </p>
        <p className="pp-fade pp-delay-3 mt-5 text-[13px] leading-relaxed text-neutral-500">
          No internet. No cloud API. No hardware in the vehicle. An ordinary
          Android phone.
        </p>

        <div className="pp-fade pp-delay-4 mt-9 flex flex-wrap gap-3">
          <Link
            href="/"
            className="pp-press rounded-xl bg-sky-500 px-5 py-3 text-[14px] font-semibold text-white shadow-lg shadow-sky-500/20 hover:bg-sky-400"
          >
            Open the live demo
          </Link>
          <a
            href="#get"
            className="pp-press rounded-xl border border-white/12 px-5 py-3 text-[14px] text-neutral-300 hover:bg-white/5"
          >
            Install the app
          </a>
        </div>
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------- problem */

function Problem() {
  return (
    <Section eyebrow="The problem" title="Satellite signals cannot pass through concrete.">
      <p className="max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        GNSS signals arrive about as faint as a 20-watt bulb seen from
        20,000&nbsp;km. They do not survive a tunnel, a basement, or an urban
        canyon — and the usual fallbacks do not help: mobile-tower positioning
        is accurate to somewhere between 500&nbsp;m and 2&nbsp;km, which tells
        you which city you are in, not which exit is next.
      </p>
      <div className="mt-8 grid gap-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.06] sm:grid-cols-3">
        {[
          ['Tunnels & underpasses', 'No sky, no signal. Minutes at a time.'],
          ['Multi-level parking', 'No sky, and often no mobile network either.'],
          ['Urban canyons', 'Worse than absence — signals bounce and arrive late, so the phone is confidently wrong.'],
        ].map(([h, b]) => (
          <div key={h} className="bg-[#080b11] p-5">
            <h3 className="text-[13px] font-semibold text-neutral-200">{h}</h3>
            <p className="mt-2 text-[12.5px] leading-relaxed text-neutral-500">{b}</p>
          </div>
        ))}
      </div>
      <p className="mt-6 max-w-2xl text-[13px] leading-relaxed text-neutral-500">
        The problem statement notes that high-end cars carry factory-fitted
        inertial systems wired to the wheels — but commercial trucks, older
        cars, and millions of two-wheelers have nothing but the phone on the
        dashboard. So the system has to work from that phone alone.
      </p>
    </Section>
  );
}

/* ------------------------------------------------------------ how it works */

function HowItWorks() {
  return (
    <Section eyebrow="How it works" title="Dead reckoning, and five rules that stop it drifting.">
      <p className="max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        Dead reckoning is older than electricity: if you know where you started,
        how fast you have gone and which way you were pointing, you can compute
        where you are without seeing anything outside. The catch is that small
        sensor errors compound — error grows with{' '}
        <span className="text-neutral-200">time squared</span>. Everything
        interesting in this project is about fighting that.
      </p>

      <div className="mt-8 rounded-xl border border-sky-400/20 bg-sky-500/[0.06] p-5">
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-sky-300">
          Shadow mode — why the handover takes zero time
        </h3>
        <p className="mt-2.5 max-w-2xl text-[13.5px] leading-relaxed text-neutral-400">
          Most implementations start dead reckoning when GNSS fails. This one
          runs it <em className="not-italic text-neutral-200">continuously</em>,
          from the moment the app opens, reset by every good fix. So when the
          signal dies there is nothing to spin up and no filter to initialise.
          The problem statement asks for a seamless handover &ldquo;within
          milliseconds&rdquo;; ours costs zero, because there is no handover.
        </p>
      </div>

      <div className="mt-8 space-y-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.06]">
        {[
          ['NHC', 'A car cannot slide sideways', 'Sideways motion in the estimate is error, not travel — so it is removed. The single biggest improvement we make: about 59% error down to 29%.'],
          ['ZUPT', 'A stopped vehicle has zero speed', 'Detect stillness and force speed to exactly zero. It also calibrates the accelerometer for free: whatever it reads while stopped must be error.'],
          ['ZARU', 'A stopped vehicle is not turning', 'The same trick for the gyroscope. Heading error is the worst kind — a few degrees wrong takes you further sideways with every metre.'],
          ['Speed clamp', 'Vehicles obey physics', 'A plausibility ceiling, plus the matched road’s speed limit. And unaided speed is bled toward zero over a long outage rather than confidently asserted.'],
          ['Road snapping', 'Cars are on roads', 'Real OpenStreetMap geometry ships inside the app. Correction is sideways only — the map says which road, never how far along it, because that is the answer we are computing.'],
        ].map(([tag, rule, body]) => (
          <div key={tag} className="bg-[#080b11] p-5 sm:flex sm:gap-6">
            <div className="sm:w-40 sm:shrink-0">
              <span className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                {tag}
              </span>
              <h3 className="mt-2 text-[13px] font-semibold text-neutral-200">{rule}</h3>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-neutral-500 sm:mt-0">
              {body}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- results */

function Results() {
  return (
    <Section eyebrow="Measured" title="10.0% mean drift — and the tail we do not hide.">
      <div className="grid gap-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.06] sm:grid-cols-4">
        {[
          ['10.0%', 'mean drift'],
          ['6.4%', 'median'],
          ['22.6%', '90th percentile'],
          ['12', 'runs'],
        ].map(([n, l]) => (
          <div key={l} className="bg-[#080b11] p-5 text-center">
            <div className="tabular font-mono text-[1.75rem] font-semibold leading-none text-white">
              {n}
            </div>
            <div className="mt-2 text-[10.5px] uppercase tracking-wide text-neutral-500">
              {l}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Note title="On the line, not under it">
          The target is under 10%. Our mean is 10.0%. We say that rather than
          rounding in our own favour.
        </Note>
        <Note title="The 90th percentile fails">
          22.6% does not meet the target. Quote only the mean and the first
          careful reader finds the tail — so we put it on the slide ourselves.
        </Note>
        <Note title="All of it is simulated" warn>
          We have no recording of a real drive yet. These numbers measure the
          software against a physics model, not against a road.
        </Note>
      </div>

      <p className="mt-8 max-w-2xl text-[13px] leading-relaxed text-neutral-500">
        Ground truth comes from driving where GNSS is{' '}
        <span className="text-neutral-300">good</span>, recording everything,
        then deleting the satellite fixes from a window in software before the
        estimator sees them. The estimator experiences a total outage; we still
        hold the positions it cannot see. It cannot have been fitted to an
        answer it was never shown. Each row of the results table changes exactly
        one component, and the table is generated by running the software —
        nobody types the numbers.
      </p>

      <p className="mt-5 max-w-2xl rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-[12.5px] leading-relaxed text-neutral-400">
        <span className="font-semibold text-neutral-200">
          One component is shipped switched off.
        </span>{' '}
        A forward-bias correction measured worse — 12.8% against 10.0% — so it
        was disabled, kept, and left in the results table with its real figure.
      </p>
    </Section>
  );
}

/* --------------------------------------------------------------------- ai */

function Ai() {
  return (
    <Section eyebrow="The AI" title="The one thing physics alone cannot answer.">
      <p className="max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        An accelerometer measures <em className="not-italic text-neutral-200">changes</em>{' '}
        in speed. At a steady 50&nbsp;km/h on a smooth road it reads the same as
        a parked car — that is physics, not a cheap sensor. During an outage
        that is exactly the situation, and it is why a model earns its place.
      </p>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        A moving car is never truly smooth. Engine vibration, road texture and
        tyre noise produce a fine tremor whose frequency content differs
        measurably at 20&nbsp;km/h and at 80. A 1D convolutional network trained
        on <span className="text-neutral-200">IO-VNBD</span> — phone IMU in, the
        car&rsquo;s own wheel-speed sensor as the label — reads it.
      </p>

      <div className="mt-8 grid gap-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.06] sm:grid-cols-4">
        {[
          ['135 KB', 'on device'],
          ['1.4 ms', 'per prediction'],
          ['26,081', 'parameters'],
          ['0', 'network calls'],
        ].map(([n, l]) => (
          <div key={l} className="bg-[#080b11] p-5 text-center">
            <div className="tabular font-mono text-[1.4rem] font-semibold leading-none text-white">
              {n}
            </div>
            <div className="mt-2 text-[10.5px] uppercase tracking-wide text-neutral-500">
              {l}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-6 max-w-2xl text-[13px] leading-relaxed text-neutral-500">
        It beats both alternatives and it is not precise — mean error about
        3.7&nbsp;m/s, against 4.8 for a classical ridge regression and 8.7 for
        assuming constant speed. All three are reported, because a model with no
        baseline is an unfalsifiable claim. Train/test is split{' '}
        <span className="text-neutral-300">by recording, never at random</span>,
        which is the difference between a real result and a fictional one.
      </p>
      <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-neutral-500">
        Inference runs on the phone. A cloud model needs a network, and in the
        exact place this app exists to serve there is none — which is not a
        limitation but a disqualification.
      </p>
    </Section>
  );
}

/* ----------------------------------------------------------- deliverables */

function Deliverables() {
  return (
    <Section eyebrow="Architecture" title="One navigation core, two deployment targets.">
      <p className="max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        Every line of navigation mathematics lives in one pure TypeScript
        package that may not touch the screen, the network, the file system or
        a sensor. It is functions: numbers in, numbers out. That rule is
        enforced mechanically on every build.
      </p>
      <pre className="mt-7 overflow-x-auto rounded-xl border border-white/[0.08] bg-[#080b11] p-5 font-mono text-[11.5px] leading-relaxed text-neutral-400">
{`nav-core  ·  pure TypeScript, zero dependencies
   │
   ├─→  Android app        phone MEMS IMU      ~10 Hz
   └─→  Edge engine        external IMU        ~200 Hz`}
      </pre>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Note title="Mobile application">
          Map, uncertainty ellipse, live readings, event log and constraint
          switches you can break on purpose. Capacitor, ~6 MB, works offline.
        </Note>
        <Note title="Edge-deployable engine">
          The same estimator off the phone, consuming an external inertial
          stream. Sustains 200 Hz with ~370&times; headroom; 0.013 ms per
          update. Both are required by the problem statement — &ldquo;and&rdquo;,
          not &ldquo;or&rdquo;.
        </Note>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------- limitations */

function Honest() {
  const rows: Array<[string, 'Done' | 'Partial' | 'Future', string]> = [
    ['Instant switchover on signal loss', 'Done', 'Shadow mode — the switch costs zero time'],
    ['10 Hz update rate on a phone', 'Done', 'Measured from real frames and displayed live'],
    ['Trained on IO-VNBD, on-device', 'Done', 'No network call anywhere in the navigation path'],
    ['Edge-deployable engine, 200 Hz', 'Done', 'Same core, external IMU; figures are simulated'],
    ['Drift under 10% of distance', 'Partial', '10.0% mean, 6.4% median — 90th percentile 22.6% fails'],
    ['Map matching & constraints', 'Partial', 'NHC and nearest-road snapping; sequence-based matching is not built'],
    ['GNSS+INS fusion', 'Partial', 'Working and measured, but deterministic — no learned fusion, no Kalman filter yet'],
    ['Automatic phone alignment', 'Partial', 'Pitch and roll from gravity; facing direction is assumed'],
    ['Pothole / vibration rejection', 'Partial', 'Classical filters; a learned classifier is not built'],
  ];
  return (
    <Section
      eyebrow="Honest position"
      title="What is built, and what is not."
    >
      <p className="max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        Graded against the problem statement without flattery. A
        &ldquo;Partial&rdquo; with an honest sentence survives questioning; a
        &ldquo;Done&rdquo; that can be disproved in one follow-up does not — and
        once one claim falls, every other claim is re-examined.
      </p>
      <div className="mt-7 space-y-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.06]">
        {rows.map(([req, status, note]) => (
          <div key={req} className="bg-[#080b11] px-5 py-3.5 sm:flex sm:items-baseline sm:gap-5">
            <span
              className={`inline-block w-[62px] shrink-0 rounded px-1.5 py-0.5 text-center text-[9.5px] font-semibold uppercase tracking-wide ${
                status === 'Done'
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : status === 'Partial'
                    ? 'bg-amber-500/15 text-amber-300'
                    : 'bg-neutral-600/25 text-neutral-400'
              }`}
            >
              {status}
            </span>
            <span className="mt-2 block text-[13px] font-medium text-neutral-200 sm:mt-0 sm:w-64 sm:shrink-0">
              {req}
            </span>
            <span className="mt-1 block text-[12.5px] leading-relaxed text-neutral-500 sm:mt-0">
              {note}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-6 max-w-2xl text-[13px] leading-relaxed text-neutral-500">
        The largest outstanding gap is the first one to close: no real drive log
        exists yet, so every figure on this page should be read as an upper
        bound. A simulation contains the errors we thought to model; reality
        contains the ones we did not.
      </p>
    </Section>
  );
}

/* -------------------------------------------------------------------- get */

function Get() {
  return (
    <section id="get" className="border-t border-white/[0.06] bg-[#070a0f]">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <h2 className="text-[1.6rem] font-bold tracking-tight text-white">
          Try it
        </h2>
        <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-neutral-400">
          The browser demo runs the full estimator on a simulated drive — press
          Demo and watch a 60-second outage. The Android app adds real sensors
          and native location, and works in aeroplane mode once the area is
          cached.
        </p>
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div className="rounded-xl border border-white/[0.08] bg-[#080b11] p-5">
            <h3 className="text-[13px] font-semibold text-neutral-200">
              In your browser
            </h3>
            <p className="mt-2 text-[12.5px] leading-relaxed text-neutral-500">
              Nothing to install. Simulation, HUD, uncertainty ellipse and the
              constraint switches all work.
            </p>
            <Link
              href="/"
              className="pp-press mt-4 inline-flex rounded-xl bg-sky-500 px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-sky-400"
            >
              Open the demo
            </Link>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-[#080b11] p-5">
            <h3 className="text-[13px] font-semibold text-neutral-200">
              On Android
            </h3>
            <p className="mt-2 mb-4 text-[12.5px] leading-relaxed text-neutral-500">
              Real IMU, real GNSS, offline maps.
            </p>
            <DownloadApk />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- footer */

function Footer() {
  return (
    <footer className="border-t border-white/[0.06] px-6 py-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 text-[11px] text-neutral-600 sm:flex-row sm:items-center sm:justify-between">
        <span className="uppercase tracking-[0.18em]">
          Team Avinya · SIH26168 · ISRO
        </span>
        <span>
          Every figure here is produced by running the software, not typed by
          hand.
        </span>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------- primitives */

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-white/[0.06]">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-[10.5px] font-medium uppercase tracking-[0.2em] text-sky-400/70">
          {eyebrow}
        </p>
        <h2 className="mt-3 max-w-2xl text-[1.6rem] font-bold leading-tight tracking-tight text-white sm:text-[1.9rem]">
          {title}
        </h2>
        <div className="mt-7">{children}</div>
      </div>
    </section>
  );
}

function Note({
  title,
  children,
  warn,
}: {
  title: string;
  children: React.ReactNode;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        warn
          ? 'border-amber-400/25 bg-amber-500/[0.06]'
          : 'border-white/[0.08] bg-[#080b11]'
      }`}
    >
      <h3
        className={`text-[12px] font-semibold ${
          warn ? 'text-amber-300' : 'text-neutral-200'
        }`}
      >
        {title}
      </h3>
      <p className="mt-2 text-[12.5px] leading-relaxed text-neutral-500">
        {children}
      </p>
    </div>
  );
}
