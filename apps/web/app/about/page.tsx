'use client';

import Link from 'next/link';
import DownloadApk from '@/components/DownloadApk';
import dynamic from 'next/dynamic';
import LiveHero from '@/components/landing/LiveHero';
import Reveal from '@/components/landing/Reveal';
import AblationTable from '@/components/landing/AblationTable';
import SiteNav from '@/components/landing/SiteNav';

// MapLibre needs a real DOM and pulls its own CSS, so it never renders on the
// server and is not paid for until this section is reached.
const RoadGraphMap = dynamic(() => import('@/components/landing/RoadGraphMap'), {
  ssr: false,
  loading: () => <div className="h-[300px] animate-pulse rounded-xl bg-white/[0.03] sm:h-[380px]" />,
});

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
    <main id="top" className="min-h-screen bg-[#05070b] text-neutral-300">
      <SiteNav />
      <LiveHero />
      <Problem />
      <HowItWorks />
      <Results />
      <Ablation />
      <Maps />
      <Ai />
      <Deliverables />
      <EdgeEngine />
      <Stack />
      <Honest />
      <Get />
      <Footer />
    </main>
  );
}

/* ---------------------------------------------------------------- problem */

function Problem() {
  return (
    <Section id="problem" eyebrow="The problem" title="Satellite signals cannot pass through concrete.">
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
    <Section id="how" eyebrow="How it works" title="Dead reckoning, and five rules that stop it drifting.">
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
    <Section id="results" eyebrow="Measured" title="10.0% mean drift — and the tail we do not hide.">
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
    <Section id="ai" eyebrow="The AI" title="The one thing physics alone cannot answer.">
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

      {/*
        ★ THE SCREENING ARTEFACT ★
        The problem statement requires the position plot inferred from IO-VNBD
        as part of the proposal — it is an entry ticket, not a bonus. This is
        that file, produced by ml/evaluate_position.py, not a redrawing of it.
      */}
      <figure className="mt-9 overflow-hidden rounded-xl border border-white/[0.08] bg-[#080b11]">
        <div className="border-b border-white/[0.07] px-5 py-3">
          <span className="rounded bg-sky-500/15 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-sky-300">
            Required screening artefact
          </span>
          <p className="mt-2 text-[12.5px] text-neutral-400">
            Position plot inferred from a held-out IO-VNBD sequence — predicted
            trajectory against known truth.
          </p>
        </div>
        {/* Plain <img>: next/image's optimiser is disabled under static export
            anyway, so it would add an abstraction and no benefit. */}
        <img
          src="ml/position_plot.png"
          alt="Predicted vehicle trajectory against ground truth, speed over time, and position error, from the IO-VNBD held-out sequence."
          className="w-full bg-white"
          loading="lazy"
          decoding="async"
        />
        <figcaption className="border-t border-white/[0.07] px-5 py-3 text-[11.5px] leading-relaxed text-neutral-500">
          Generated by <code className="text-neutral-400">ml/evaluate_position.py</code>{' '}
          on sequence <code className="text-neutral-400">Vw02</code>, held out
          entirely from training. Dead reckoning driven by the model&rsquo;s own
          speed predictions, scored against the recorded path.
        </figcaption>
      </figure>
    </Section>
  );
}

/* ----------------------------------------------------------- deliverables */

function Deliverables() {
  return (
    <Section id="arch" eyebrow="Architecture" title="One navigation core, two deployment targets.">
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

/* --------------------------------------------------------------- ablation */

function Ablation() {
  return (
    <Section
      id="ablation"
      eyebrow="Ablation"
      title="Every constraint, measured one at a time."
    >
      <p className="mb-7 max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        Each row differs from the one above it by exactly one component, so
        every improvement is attributable to something specific rather than to
        the system as a whole. This is the difference between an engineering
        result and a claim.
      </p>
      <AblationTable />
    </Section>
  );
}

/* ------------------------------------------------------------------- maps */

function Maps() {
  return (
    <Section
      id="maps"
      eyebrow="Offline maps"
      title="The road network ships inside the app."
    >
      <p className="mb-7 max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        Road snapping needs geometry, and a tunnel has no network to fetch it
        from. So the graph is generated once from OpenStreetMap and bundled —
        every way below is in the APK, read by the estimator at 10&nbsp;Hz
        through a grid spatial index. Nothing here touches the network at
        runtime.
      </p>
      <RoadGraphMap />
      <p className="mt-4 max-w-2xl text-[12.5px] leading-relaxed text-neutral-500">
        The dashed rectangle is the coverage boundary. Outside it the app
        reports that it has no graph rather than pretending to match — an
        unmatched position is a real state, and inventing a road for it would be
        the one lie map matching must never tell.
      </p>
    </Section>
  );
}

/* ------------------------------------------------------------ edge engine */

function EdgeEngine() {
  return (
    <Section
      id="edge"
      eyebrow="Edge engine"
      title="The same estimator, off the phone, at 200 Hz."
    >
      <p className="max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        The problem statement asks for models that work with external inertial
        sensors, not only a handset&rsquo;s. Because the core has no
        phone-specific dependencies, that was a porting exercise: a Node CLI
        that consumes an external IMU stream and emits the same navigation
        state.
      </p>
      <div className="mt-7 grid gap-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.06] sm:grid-cols-3">
        {[
          ['0.013 ms', 'mean update latency', 'the budget at 200 Hz is 5 ms'],
          ['370\u00d7', 'faster than real time', 'so the rate is not the bottleneck'],
          ['3', 'sensor grades', 'phone MEMS, tactical, fibre-optic'],
        ].map(([n, l, sub]) => (
          <div key={l} className="bg-[#080b11] p-5">
            <div className="tabular font-mono text-[1.5rem] font-semibold leading-none text-white">
              {n}
            </div>
            <div className="mt-2 text-[11px] text-neutral-300">{l}</div>
            <div className="mt-1 text-[11px] leading-snug text-neutral-600">{sub}</div>
          </div>
        ))}
      </div>
      <p className="mt-5 max-w-2xl rounded-lg border border-amber-400/20 bg-amber-500/[0.05] px-4 py-3 text-[12.5px] leading-relaxed text-neutral-400">
        <span className="font-semibold text-amber-300">Stated plainly:</span> we
        do not own a fibre-optic or tactical IMU — they cost several lakh rupees,
        and the requirement is to support that class of <em className="not-italic">data</em>,
        not to possess the hardware. Those grades are datasheet noise models
        driving a simulator, and every figure from them is a simulation result.
      </p>
    </Section>
  );
}

/* ------------------------------------------------------------------ stack */

function Stack() {
  const rows: Array<[string, string, string]> = [
    ['Navigation core', 'Pure TypeScript', 'Zero dependencies, zero I/O. Enforced on every build.'],
    ['Mobile app', 'Next.js 14 + Capacitor 6', 'Static export wrapped into a ~6 MB APK.'],
    ['Maps', 'MapLibre GL + OpenStreetMap', 'Free, offline-capable, no proprietary tiles.'],
    ['Model training', 'PyTorch', '1D-CNN on IO-VNBD; exported to ONNX.'],
    ['On-device inference', 'Hand-written TypeScript', 'No ONNX Runtime — it would have cost 14 MB of WebAssembly for a 26k-parameter model.'],
    ['Edge engine', 'Node.js', 'Same core, external IMU adapters.'],
    ['Testing', 'Vitest', '1,191 tests across five packages.'],
  ];
  return (
    <Section id="stack" eyebrow="Built with" title="Free tools, and one deliberate omission.">
      <div className="space-y-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.06]">
        {rows.map(([area, tech, why]) => (
          <div key={area} className="bg-[#080b11] px-5 py-3.5 sm:flex sm:gap-5">
            <span className="block text-[12.5px] font-medium text-neutral-500 sm:w-44 sm:shrink-0">
              {area}
            </span>
            <span className="mt-1 block text-[13px] font-semibold text-neutral-200 sm:mt-0 sm:w-56 sm:shrink-0">
              {tech}
            </span>
            <span className="mt-1 block text-[12px] leading-relaxed text-neutral-500 sm:mt-0">
              {why}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-5 max-w-2xl text-[13px] leading-relaxed text-neutral-500">
        Total spend: <span className="text-neutral-300">&#8377;0</span>. No paid
        APIs, no IoT hardware, no cloud inference. The dataset, the map data and
        every library are open.
      </p>
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
      id="honest"
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
  id,
  eyebrow,
  title,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="border-t border-white/[0.06]">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-[10.5px] font-medium uppercase tracking-[0.2em] text-sky-400/70">
          {eyebrow}
        </p>
        <h2 className="mt-3 max-w-2xl text-[1.6rem] font-bold leading-tight tracking-tight text-white sm:text-[1.9rem]">
          {title}
        </h2>
        <Reveal className="mt-7">{children}</Reveal>
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
