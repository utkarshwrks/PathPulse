'use client';

import { useState } from 'react';
import { summariseConstellations } from '@pathpulse/nav-core';
import type { NavEvent, SensorSample, SessionSummary } from '@pathpulse/nav-core';
import type { EngineControls, EngineDiagnostics, LastGnss } from '@/hooks/useNavigationEngine';
import type { RoadGraphEntry } from '@/lib/roadGraph';
import type { ModelInfo } from '@/lib/ml/speedModel';

interface TrustPanelProps {
  sample: SensorSample | null;
  lastGnss: LastGnss | null;
  roadGraphEntry: RoadGraphEntry | null;
  diagnostics: EngineDiagnostics;
  stats: SessionSummary;
  events: NavEvent[];
  controls: EngineControls;
  onControlsChange: (patch: Partial<EngineControls>) => void;
  onExportEvents: () => void;
  /** Phase 12 — the "Re-calibrate" button on the CONSTRAINTS tab. */
  onRecalibrateAlignment: () => void;
  /** Phase 9F — the whole trip, as a file a judge can open later. */
  onExportTrip: (format: 'gpx' | 'geojson') => void;
  /** Points in the estimated track, so the buttons can refuse an empty trip. */
  tripPointCount: number;
  imuHz: number;
  gnssHz: number;
  updateHz: number;
  /** Whether the live source is delivering rotation rate. Undefined = unknown. */
  hasGyro?: boolean;
  /** Phase 8 — what happened when the speed model was loaded. */
  modelInfo: ModelInfo;
  /** Phase 13 — the same, for the motion-state classifier. */
  motionModelInfo: ModelInfo;
  /**
   * True when the active source is the simulator.
   *
   * Passed in rather than inferred from the data, because the whole point of
   * the constellation panel is that the viewer can tell a simulated sky from a
   * measured one — and a component that guesses its own provenance is exactly
   * the thing that would eventually guess wrong.
   */
  simulated: boolean;
}

type Tab = 'sensors' | 'constraints' | 'events' | 'stats';

/**
 * Phase 5B/5C/5D/5F — the anti-fake panel.
 *
 * ★ THIS IS WHERE CREDIBILITY IS WON ★
 * A judge's default assumption is that the demo is playing back canned data.
 * Nothing in the HUD can disprove that, because a scripted animation can show
 * any numbers it likes. These four tabs can:
 *
 *  - SENSORS: raw values, updating every frame. Real sensor data is always
 *    slightly dirty — a phone flat on a table still twitches by 0.01-0.05.
 *    Canned data is suspiciously smooth.
 *  - CONSTRAINTS: live toggles. A fake demo never breaks. Being able to switch
 *    NHC off mid-outage and watch the estimate wander, then switch it back, is
 *    the single most convincing thing in the whole build.
 *  - EVENTS: every mode change with its reason and a millisecond timestamp.
 *    An animation cannot explain itself.
 *  - STATS: measured drift from real recoveries, not our own error model.
 *
 * Tabs rather than four stacked panels because this has to be legible on a
 * phone held up in front of a judge, not just on a laptop.
 */
export default function TrustPanel({
  sample,
  lastGnss,
  roadGraphEntry,
  diagnostics,
  stats,
  events,
  controls,
  onControlsChange,
  onExportEvents,
  onRecalibrateAlignment,
  onExportTrip,
  tripPointCount,
  imuHz,
  gnssHz,
  updateHz,
  hasGyro,
  modelInfo,
  motionModelInfo,
  simulated,
}: TrustPanelProps) {
  const [tab, setTab] = useState<Tab>('sensors');

  /**
   * ★ THIS PANEL PLACED ITSELF, AND GOT IT WRONG ★
   * It used to own its corner, its layer and its own close button — which was
   * positioned `top-0 -translate-y-9` on a container anchored at `top-2`, so
   * the ✕ rendered around y = -34 px, off the top of the screen. The panel
   * could be opened and then not dismissed. That is precisely the class of bug
   * the shared Sheet exists to make unexpressible, and this was the one panel
   * still exempt from it.
   *
   * It now renders content only. Position, layer, scrolling and the close
   * button all belong to Sheet.
   */
  return (
    <div data-tour="debug">
      <div className="flex items-center gap-1.5 pb-2 text-[10px] text-neutral-500">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            diagnostics.isStationary ? 'bg-sky-400' : 'bg-emerald-400'
          }`}
        />
        {diagnostics.isStationary ? 'stationary' : 'moving'}
      </div>

      {true ? (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-black/40">
          <div className="flex border-b border-white/10 text-[10px] font-medium">
            {(
              [
                ['sensors', 'SENSORS'],
                ['constraints', 'CONSTRAINTS'],
                ['events', 'EVENTS'],
                ['stats', 'STATS'],
              ] as Array<[Tab, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`flex-1 px-2 py-2 tracking-wide transition ${
                  tab === key
                    ? 'bg-white/10 text-neutral-100'
                    : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="max-h-[52vh] overflow-y-auto px-3 py-2.5">
            {tab === 'sensors' ? (
              <SensorsTab
                sample={sample}
                lastGnss={lastGnss}
                roadGraphEntry={roadGraphEntry}
                diagnostics={diagnostics}
                modelInfo={modelInfo}
                motionModelInfo={motionModelInfo}
                imuHz={imuHz}
                gnssHz={gnssHz}
                updateHz={updateHz}
                hasGyro={hasGyro}
                simulated={simulated}
              />
            ) : null}
            {tab === 'constraints' ? (
              <ConstraintsTab
                controls={controls}
                onChange={onControlsChange}
                alignment={diagnostics.alignment}
                onRecalibrate={onRecalibrateAlignment}
              />
            ) : null}
            {tab === 'events' ? (
              <EventsTab
                events={events}
                onExport={onExportEvents}
                onExportTrip={onExportTrip}
                tripPointCount={tripPointCount}
              />
            ) : null}
            {tab === 'stats' ? <StatsTab stats={stats} diagnostics={diagnostics} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- 5B */

function SensorsTab({
  sample,
  lastGnss,
  roadGraphEntry,
  diagnostics,
  modelInfo,
  motionModelInfo,
  imuHz,
  gnssHz,
  updateHz,
  hasGyro,
  simulated,
}: {
  sample: SensorSample | null;
  lastGnss: LastGnss | null;
  roadGraphEntry: RoadGraphEntry | null;
  diagnostics: EngineDiagnostics;
  modelInfo: ModelInfo;
  motionModelInfo: ModelInfo;
  imuHz: number;
  gnssHz: number;
  updateHz: number;
  hasGyro?: boolean;
  simulated: boolean;
}) {
  const imu = sample?.imu;
  // Fixes are hundreds of times rarer than IMU samples, so read the last one
  // rather than only whichever sample happens to be on screen.
  const gnss = lastGnss?.gnss;

  return (
    <div className="tabular space-y-2.5 font-mono text-[10.5px] text-neutral-300">
      <Group title="raw imu">
        <Axis label="ACCEL" x={imu?.ax} y={imu?.ay} z={imu?.az} unit="m/s²" digits={2} />
        <Axis label="GYRO" x={imu?.gx} y={imu?.gy} z={imu?.gz} unit="rad/s" digits={4} />
        {/*
          A gyroscope the platform never supplies reads as an unbroken column
          of 0.0000, which looks like a vehicle driving perfectly straight
          rather than like a missing sensor. Dead reckoning cannot turn without
          it, so this says so outright instead of leaving the straight line to
          be blamed on the estimator.
        */}
        {hasGyro === false && (
          <Row k="GYRO" v="UNAVAILABLE — DR cannot track turns" warn />
        )}
      </Group>

      <Group title="rates (measured)">
        <Row k="IMU" v={`${imuHz.toFixed(1)} Hz`} />
        <Row k="GNSS" v={`${gnssHz.toFixed(2)} Hz`} />
        <Row k="ENGINE OUT" v={`${updateHz.toFixed(1)} Hz`} warn={updateHz > 0 && updateHz < 10} />
        <Row
          k="FIX INTERVAL"
          v={
            diagnostics.observedFixIntervalMs === null
              ? 'learning…'
              : `${(diagnostics.observedFixIntervalMs / 1000).toFixed(1)} s`
          }
        />
        <Row
          k="LOSS TIMEOUT"
          v={`${(diagnostics.effectiveNoFixTimeoutMs / 1000).toFixed(1)} s`}
        />
      </Group>

      <Group title="gnss (last fix)">
        <Row
          k="FIX AGE"
          v={lastGnss ? `${(lastGnss.ageMs / 1000).toFixed(1)} s` : 'no fix yet'}
          warn={lastGnss !== null && lastGnss.ageMs > diagnostics.effectiveNoFixTimeoutMs}
        />
        <Row k="ACCURACY" v={gnss ? `${gnss.accuracyM.toFixed(1)} m` : '—'} />
        <Row
          k="SPEED"
          v={gnss?.speedMps != null ? `${gnss.speedMps.toFixed(1)} m/s` : 'not reported'}
        />
        {/*
          ★ SAY WHY WE ARE STILL ACQUIRING. ★
          INITIALIZING has one exit: two consecutive fixes at 20 m or better.
          Indoors that may never clear, and because DEAD_RECKONING is only
          reachable through GNSS, switching GPS off then does nothing either.
          The engine knew the reason all along and used to keep it to itself.
        */}
        {diagnostics.acquiringReason ? (
          <Row k="ACQUIRING" v={diagnostics.acquiringReason} warn />
        ) : null}
        <Row k="SATELLITES" v={gnss?.satCount != null ? String(gnss.satCount) : 'n/a'} />
        <Row k="MEAN C/N0" v={gnss?.meanCn0 != null ? `${gnss.meanCn0.toFixed(1)} dB-Hz` : 'n/a'} />
      </Group>

      <ConstellationGroup gnss={gnss} simulated={simulated} />

      <Group title="road matching">
        <Row
          k="GRAPH"
          v={roadGraphEntry ? `${roadGraphEntry.name} (${roadGraphEntry.ways} ways)` : 'none here'}
          warn={roadGraphEntry === null}
        />
        <Row k="MATCHED" v={diagnostics.matchedRoadName ?? '—'} />
        <Row
          k="DISTANCE"
          v={
            diagnostics.matchedRoadDistanceM === null
              ? '—'
              : `${diagnostics.matchedRoadDistanceM.toFixed(1)} m`
          }
        />
        <Row
          k="COVERAGE"
          v={`${(diagnostics.roadSnapAppliedFraction * 100).toFixed(0)} %`}
        />
      </Group>

      {/*
        ★ PHASE 8 — the live proof the model is doing something. ★
        The comparison line is the valuable one: while GNSS is up we know the
        real speed, so we can show the model's error AS IT HAPPENS. A judge can
        watch the prediction track the truth before the outage even starts,
        which is a far stronger claim than a number on a slide.
      */}
      {/*
        ★ PHASE 13 — the second of the three models the problem statement asks
        for. Shown next to the speed model rather than buried, because "AI is
        used in three places" is a claim a judge will want to see running.
      */}
      <Group title="ai motion classifier">
        <Row
          k="MODEL"
          v={
            motionModelInfo.loaded
              ? `loaded, ${(motionModelInfo.sizeBytes / 1024).toFixed(0)} KB`
              : (motionModelInfo.error ?? 'not loaded')
          }
          warn={!motionModelInfo.loaded}
        />
        <Row
          k="STATE"
          v={diagnostics.motionState ?? 'unknown'}
          accent={diagnostics.motionState !== null}
        />
        <Row
          k="CONFIDENCE"
          v={
            diagnostics.motionConfidence > 0
              ? `${(diagnostics.motionConfidence * 100).toFixed(0)}%`
              : '—'
          }
        />
        <Row k="INFERENCES" v={String(diagnostics.motionInferences)} />
        <Row
          k="POTHOLES REJECTED"
          v={String(diagnostics.potholesRejected)}
          accent={diagnostics.potholesRejected > 0}
        />
        <Row
          k="LATENCY"
          v={
            Number.isFinite(motionModelInfo.latencyMs)
              ? `${motionModelInfo.latencyMs.toFixed(2)} ms`
              : '—'
          }
        />
      </Group>

      <Group title="ai speed model">
        <Row
          k="MODEL"
          v={
            diagnostics.mlError
              ? `disabled: ${diagnostics.mlError}`
              : modelInfo.loaded
                ? `loaded, ${(modelInfo.sizeBytes / 1024).toFixed(0)} KB`
                : (modelInfo.error ?? 'not loaded')
          }
          warn={!modelInfo.loaded || diagnostics.mlError !== null}
        />
        <Row k="SOURCE" v={diagnostics.speedSource} accent={diagnostics.speedSource === 'ML'} />
        <Row
          k="LATENCY"
          v={Number.isFinite(modelInfo.latencyMs) ? `${modelInfo.latencyMs.toFixed(1)} ms` : '—'}
          warn={Number.isFinite(modelInfo.latencyMs) && modelInfo.latencyMs > 20}
        />
        <Row k="INFERENCES" v={String(modelInfo.inferences)} />
        <Row
          k="PREDICTED"
          v={
            Number.isFinite(diagnostics.mlSpeedMps)
              ? `${(diagnostics.mlSpeedMps * 3.6).toFixed(1)} km/h`
              : '—'
          }
        />
        <Row
          k="GNSS ACTUAL"
          v={gnss?.speedMps != null ? `${(gnss.speedMps * 3.6).toFixed(1)} km/h` : 'n/a'}
        />
        <Row
          k="ERROR"
          v={
            Number.isFinite(diagnostics.mlSpeedMps) && gnss?.speedMps != null
              ? `${Math.abs(diagnostics.mlSpeedMps - gnss.speedMps).toFixed(2)} m/s`
              : '—'
          }
        />
      </Group>

      <Group title="estimator">
        {/*
          ★ THE CLASSIFIER DECIDES THREE THINGS, SO IT HAS TO BE VISIBLE ★
          Whether the speed model is consulted, whether device yaw is
          integrated into the heading, and whether GNSS may assert a stop. If a
          judge asks why the AI badge disappeared when the phone was picked up,
          the answer has to be on screen next to the reason it decided.
        */}
        <Row k="MOTION" v={diagnostics.motionContext} accent={diagnostics.motionContext === 'PEDESTRIAN'} />
        <Row k="  WHY" v={diagnostics.motionReason} />
        {diagnostics.mlSuppressed ? (
          <Row k="AI SPEED" v="held — out of domain" accent />
        ) : null}
        {/*
          The cadence is the corroboration the variance cannot give. A scooter
          on a bad road shakes the handset as hard as a walk does; only a walk
          does it rhythmically at one to three hertz. The stride beside it is
          the number GNSS taught us about this carrier, and it is what the
          estimate runs on once GNSS is gone.
        */}
        {diagnostics.cadenceHz > 0 || diagnostics.stepCount > 0 ? (
          <Row
            k="CADENCE"
            v={`${diagnostics.cadenceHz.toFixed(1)}/s · ${diagnostics.stepCount} steps`}
          />
        ) : null}
        {diagnostics.strideObservations > 0 ? (
          <Row
            k="STRIDE"
            v={`${diagnostics.strideM.toFixed(2)} m (${diagnostics.strideObservations})`}
          />
        ) : null}
        <Row
          k="STATIONARY"
          v={diagnostics.isStationary ? 'YES' : 'NO'}
          accent={diagnostics.isStationary}
        />
        <Row
          k="ACCEL VAR"
          v={Number.isFinite(diagnostics.accelVariance) ? diagnostics.accelVariance.toFixed(4) : '—'}
        />
        <Row k="ATTITUDE" v={diagnostics.attitudeSettled ? `${(diagnostics.attitudeQuality * 100).toFixed(0)}%` : 'settling…'} />
        <Row k="ACCEL BIAS" v={vec(diagnostics.accelBias, 3)} />
        <Row k="GYRO BIAS" v={vec(diagnostics.gyroBias, 4)} />
        <Row
          k="FWD BIAS"
          v={`${diagnostics.forwardBiasMps2.toFixed(3)} (${diagnostics.forwardBiasObservations})`}
        />
        <Row k="UNAIDED" v={`${(diagnostics.unaidedMs / 1000).toFixed(1)} s`} />
        <Row k="ZUPT / ZARU" v={`${diagnostics.zuptTriggers} / ${diagnostics.zaruTriggers}`} />
      </Group>

      <p className="pt-0.5 text-[9.5px] leading-snug text-neutral-500">
        SPEED reading “not reported” is normal: many Android devices return no
        Doppler speed, so the engine derives it from consecutive fixes instead.
        Satellite provenance is stated in the constellations group above rather
        than repeated here.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- 5C */

const TOGGLES: Array<{ key: keyof EngineControls; label: string; hint: string }> = [
  { key: 'nhc', label: 'NHC', hint: 'A vehicle cannot slide sideways. Kills cross-track drift.' },
  { key: 'zupt', label: 'ZUPT', hint: 'Stopped means speed exactly zero, and free accel calibration.' },
  { key: 'zaru', label: 'ZARU', hint: 'Stopped means the gyro reading is pure bias. Stops heading drift.' },
  {
    key: 'roadSnap',
    label: 'Road snapping',
    hint: 'Pulls the estimate across onto the nearest plausible road. Cross-track only — never along it.',
  },
  {
    key: 'useMlSpeed',
    label: 'AI speed model',
    hint: 'The IO-VNBD-trained CNN, used for speed when GNSS is gone. Inert until the model loads — see the SENSORS tab.',
  },
  {
    key: 'mlVehicleOnly',
    label: 'AI model: vehicle only',
    hint: 'The model was trained on car data. On foot it saturated the ceiling and the HUD read a flat 11 km/h. Off puts that back.',
  },
  {
    key: 'pedestrianHeadingFromGnss',
    label: 'On foot: course from GNSS',
    hint: 'A hand is not a chassis. Off integrates device yaw on foot, which drew the star-shaped trail over a straight footpath.',
  },
  {
    key: 'accelHighPass',
    label: 'Accel high-pass',
    hint: 'Removes the slow mean of forward acceleration — the tilt error that makes DR speed run away.',
  },
  {
    key: 'forwardBias',
    label: 'Forward bias (off — measured worse)',
    hint: 'Learns mount tilt from GNSS Doppler. Superseded by the high-pass: 12.7% drift without it, 19.1% with. Left here to demonstrate.',
  },
  { key: 'speedClamp', label: 'Speed clamp', hint: 'Plausibility ceiling plus decay of a stale unaided estimate.' },
  { key: 'lowPass', label: 'Low-pass filter', hint: 'Removes engine and road vibration before integration.' },
  { key: 'medianFilter', label: 'Median filter', hint: 'Rejects pothole spikes.' },
  { key: 'adaptiveTimeout', label: 'Adaptive GNSS timeout', hint: 'Track the receiver’s real fix rate instead of assuming 1 Hz.' },
  {
    key: 'hmmMatch',
    label: 'HMM map matching (off — see benchmarks)',
    hint: 'Newson-Krumm over a sliding window. Picks the most likely road SEQUENCE rather than the nearest road, so it can reject a parallel service road, the opposite carriageway or a flyover — all of which are close but unreachable. Measured slightly worse on our routes, which contain none of those.',
  },
  {
    key: 'useMlResidual',
    label: 'AI drift correction (off — measured worse)',
    hint: 'Predicts the estimator’s own error and subtracts it. Route-disjoint evaluation: 3-8× worse on an unseen route type, because city and highway features barely overlap and the network extrapolates. Inert without a model; kept so the negative result can be shown.',
  },
  {
    key: 'useMlMotion',
    label: 'AI motion classifier',
    hint: 'Eight-class 1D-CNN over one second of IMU. Fires ZUPT on a confident stop, rejects pothole impulses, and freezes the tilt estimate through corners. Inert until the model loads — see the SENSORS tab.',
  },
  {
    key: 'autoAlign',
    label: 'Automatic alignment',
    hint: 'Works out which way the phone is pointing relative to the car, from straight-line driving. Off assumes the phone’s +Y axis points along the bonnet — true of a demo cradle and of nothing else.',
  },
  {
    key: 'eskf',
    label: 'ESKF (off — better tail, worse mean)',
    hint: '15-state error-state Kalman filter for position during an outage. Measured: 10.8% mean vs 10.0%, but 17.8% p90 vs 22.7%. On is not simply better, and that is the point.',
  },
];

/**
 * Constellation breakdown, with NavIC first.
 *
 * ★ THE PROVENANCE LINE IS NOT OPTIONAL ★
 * Rendering "NavIC: 4" without saying where the 4 came from is the single
 * easiest way to lose a judge, because it is exactly the sort of claim they
 * check — and on a real phone today the honest answer is that the platform
 * reports nothing at all. The counts and the label that qualifies them are
 * therefore produced together by nav-core and displayed together here.
 */
function ConstellationGroup({
  gnss,
  simulated,
}: {
  gnss: SensorSample['gnss'] | undefined;
  simulated: boolean;
}) {
  const summary = summariseConstellations({
    ...(gnss?.constellations ? { constellations: gnss.constellations } : {}),
    ...(gnss?.satCount != null ? { satCount: gnss.satCount } : {}),
    // Both: the marker on the fix is authoritative and survives a source
    // switch, while the caller's flag covers a source that forgets to set it.
    // Either one being true means simulated; provenance is never upgraded.
    ...(gnss?.constellationsSimulated ? { constellationsSimulated: true } : {}),
    simulated,
  });

  const tone =
    summary.provenance === 'measured'
      ? 'text-emerald-300'
      : summary.provenance === 'simulated'
        ? 'text-sky-300'
        : 'text-amber-300';

  return (
    <Group title="constellations">
      <Row k="DATA SOURCE" v={summary.provenance.toUpperCase()} />
      {summary.rows.length > 0 ? (
        <>
          {summary.rows.map((r) => (
            <Row
              key={r.id}
              k={r.label.toUpperCase()}
              v={String(r.count)}
              accent={r.id === 'NAVIC'}
            />
          ))}
          {summary.unlistedCount > 0 ? (
            <Row k="UNNAMED" v={String(summary.unlistedCount)} warn />
          ) : null}
          <Row k="TOTAL" v={String(summary.total ?? 0)} />
        </>
      ) : (
        <Row k="BREAKDOWN" v="no per-constellation data" warn />
      )}
      <p className={`pt-1 text-[10px] leading-snug ${tone}`}>{summary.note}</p>
    </Group>
  );
}

function ConstraintsTab({
  controls,
  onChange,
  alignment,
  onRecalibrate,
}: {
  controls: EngineControls;
  onChange: (patch: Partial<EngineControls>) => void;
  alignment: EngineDiagnostics['alignment'];
  onRecalibrate: () => void;
}) {
  return (
    <div className="space-y-1">
      <p className="pb-1.5 text-[9.5px] leading-snug text-neutral-500">
        Live — effective on the next sample, no restart. Switch one off during an
        outage and watch the estimate degrade.
      </p>

      <AlignmentCard alignment={alignment} onRecalibrate={onRecalibrate} enabled={controls.autoAlign} />

      {TOGGLES.map((t) => (
        <Toggle
          key={t.key}
          label={t.label}
          hint={t.hint}
          checked={Boolean(controls[t.key])}
          onChange={(v) => onChange({ [t.key]: v } as Partial<EngineControls>)}
        />
      ))}

      <div className="mt-2 border-t border-white/10 pt-2">
        <Toggle
          label="Walking Mode"
          hint="Clamps speed to 3 m/s so the engine can be demonstrated on foot."
          checked={controls.walkingMode}
          onChange={(v) => onChange({ walkingMode: v })}
        />
      </div>

      <p className="pt-2 text-[9.5px] leading-snug text-neutral-500">
        Road snapping only engages where a road graph covers the area — check
        GRAPH on the SENSORS tab.
      </p>
    </div>
  );
}

/**
 * Phase 12's alignment readout.
 *
 * ★ THE STATUS IS THE POINT, NOT THE NUMBER ★
 * An alignment engine that quietly keeps reporting a stale answer after the
 * phone has been knocked is worse than none, because the failure is invisible.
 * So this shows what the engine currently believes AND how sure it is, and it
 * says REALIGNING in amber when it has thrown an answer away — at the same
 * moment the confidence bar drops. A judge who knocks the phone should be able
 * to watch the system notice.
 */
function AlignmentCard({
  alignment,
  onRecalibrate,
  enabled,
}: {
  alignment: EngineDiagnostics['alignment'];
  onRecalibrate: () => void;
  enabled: boolean;
}) {
  const { status, yawOffsetRad, quality, mount, pitchDeg, rollDeg, observations } = alignment;
  const tone =
    !enabled
      ? 'text-neutral-500'
      : status === 'ALIGNED'
        ? 'text-emerald-400'
        : status === 'REALIGNING'
          ? 'text-amber-400'
          : 'text-neutral-400';

  const offsetDeg = (yawOffsetRad * 180) / Math.PI;

  return (
    <div className="mb-2 rounded border border-white/10 bg-white/[0.02] p-2">
      <div className="flex items-center justify-between">
        <span className="text-[9.5px] tracking-wider text-neutral-500">PHONE → VEHICLE</span>
        <span className={`text-[10px] font-medium ${tone}`}>
          {enabled ? status : 'OFF — ASSUMING 0°'}
        </span>
      </div>

      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
        <Row k="MOUNT OFFSET" v={enabled && status === 'ALIGNED' ? `${offsetDeg.toFixed(1)}°` : '—'} />
        <Row k="CONFIDENCE" v={enabled && status === 'ALIGNED' ? `${(quality * 100).toFixed(0)}%` : '—'} />
        <Row k="PITCH / ROLL" v={`${pitchDeg.toFixed(0)}° / ${rollDeg.toFixed(0)}°`} />
        <Row k="HOLDER" v={mount} />
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <p className="text-[9px] leading-snug text-neutral-500">
          {!enabled
            ? 'Switched off — the estimator assumes the phone points along the bonnet.'
            : status === 'ALIGNED'
              ? `Learned from ${observations} straight stretch${observations === 1 ? '' : 'es'}. Pitch and roll come from gravity, continuously.`
              : status === 'REALIGNING'
                ? 'The phone moved. Confidence is reduced until a straight stretch re-establishes the mount.'
                : 'Needs a straight stretch above 18 km/h with some accelerating and braking in it.'}
        </p>
        <button
          type="button"
          onClick={onRecalibrate}
          className="shrink-0 rounded border border-white/15 px-2 py-1 text-[9.5px] text-neutral-300 transition hover:border-white/30 hover:text-white"
        >
          Re-calibrate
        </button>
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-2.5 rounded-md px-1.5 py-1.5 text-left transition hover:bg-white/5"
    >
      <span
        className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition ${
          checked ? 'bg-emerald-500/80' : 'bg-white/15'
        }`}
      >
        <span
          className={`h-3 w-3 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-3' : 'translate-x-0'
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-medium text-neutral-100">{label}</span>
        <span className="block text-[9.5px] leading-snug text-neutral-500">{hint}</span>
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------- 5D */

const EVENT_COLORS: Record<string, string> = {
  MODE_CHANGE: 'text-sky-300',
  GNSS_LOST: 'text-orange-300',
  DRIFT_MEASURED: 'text-amber-300',
  RECOVERY_COMPLETE: 'text-emerald-300',
  TURN: 'text-violet-300',
  GNSS_ANOMALY: 'text-red-400',
  ROAD_MATCH: 'text-teal-300',
  ZUPT_TRIGGER: 'text-neutral-400',
  ZARU_TRIGGER: 'text-neutral-400',
  WARNING: 'text-red-400',
};

function EventsTab({
  events,
  onExport,
  onExportTrip,
  tripPointCount,
}: {
  events: NavEvent[];
  onExport: () => void;
  onExportTrip: (format: 'gpx' | 'geojson') => void;
  tripPointCount: number;
}) {
  // Newest first: during a demo the interesting line is the one that just
  // happened, and scrolling to find it wastes the moment.
  const recent = [...events].reverse().slice(0, 120);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[9.5px] text-neutral-500">{events.length} events</span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onExport}
            className="rounded border border-white/15 px-2 py-1 text-[10px] text-neutral-300 transition hover:bg-white/10"
          >
            Export JSON
          </button>
          <button
            type="button"
            onClick={() => onExportTrip('gpx')}
            disabled={tripPointCount < 2}
            className="rounded border border-white/15 px-2 py-1 text-[10px] text-neutral-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            title="Estimate and GNSS reference as two tracks, openable in QGIS or BaseCamp"
          >
            GPX
          </button>
          <button
            type="button"
            onClick={() => onExportTrip('geojson')}
            disabled={tripPointCount < 2}
            className="rounded border border-white/15 px-2 py-1 text-[10px] text-neutral-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            title="Same two tracks as GeoJSON, for geojson.io"
          >
            GeoJSON
          </button>
        </div>
      </div>

      <p className="mb-1.5 text-[9.5px] leading-snug text-neutral-500">
        GPX and GeoJSON carry two tracks — our estimate, split and named per
        mode, and the raw GNSS fixes. Open both and the gap between them is the
        drift, drawn by software we did not write.
      </p>

      {recent.length === 0 ? (
        <p className="py-3 text-center text-[10px] text-neutral-600">no events yet</p>
      ) : (
        <ul className="tabular space-y-0.5 font-mono text-[9.5px] leading-snug">
          {recent.map((e, i) => (
            <li key={`${e.t}-${i}`} className="flex gap-1.5">
              <span className="shrink-0 text-neutral-600">{formatT(e.t)}</span>
              <span className={`shrink-0 ${EVENT_COLORS[e.type] ?? 'text-neutral-400'}`}>
                {e.type}
              </span>
              <span className="min-w-0 break-words text-neutral-400">{e.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- 5F */

function StatsTab({
  stats,
  diagnostics,
}: {
  stats: SessionSummary;
  diagnostics: EngineDiagnostics;
}) {
  return (
    <div className="tabular space-y-2.5 font-mono text-[10.5px] text-neutral-300">
      <Group title="session">
        <Row k="DURATION" v={formatDuration(stats.durationMs)} />
        <Row k="DISTANCE" v={`${stats.distanceM.toFixed(0)} m`} />
        <Row k="MAX SPEED" v={`${(stats.maxSpeedMps * 3.6).toFixed(1)} km/h`} />
        <Row k="MEAN RATE" v={`${stats.meanUpdateHz.toFixed(1)} Hz`} />
      </Group>

      <Group title="outages">
        <Row k="COUNT" v={String(stats.outageCount)} />
        <Row k="TOTAL" v={formatDuration(stats.outageTotalMs)} />
        <Row k="LONGEST" v={formatDuration(stats.longestOutageMs)} />
        <Row k="ZUPT FIRED" v={String(diagnostics.zuptTriggers)} />
      </Group>

      <Group title="measured drift on recovery">
        <Row k="BEST" v={stats.bestDriftM === null ? '—' : `${stats.bestDriftM.toFixed(1)} m`} />
        <Row k="WORST" v={stats.worstDriftM === null ? '—' : `${stats.worstDriftM.toFixed(1)} m`} />
        <Row k="MEAN" v={stats.meanDriftM === null ? '—' : `${stats.meanDriftM.toFixed(1)} m`} />
      </Group>

      <p className="pt-0.5 text-[9.5px] leading-snug text-neutral-500">
        These are measured against a real fix when GNSS returned — not the
        engine’s own uncertainty model, which is what the HUD shows during an
        outage.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- shared */

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-[9px] uppercase tracking-[0.14em] text-neutral-600">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ k, v, accent, warn }: { k: string; v: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-neutral-500">{k}</span>
      <span
        className={
          warn ? 'text-amber-400' : accent ? 'text-sky-300' : 'text-neutral-100'
        }
      >
        {v}
      </span>
    </div>
  );
}

function Axis({
  label,
  x,
  y,
  z,
  unit,
  digits,
}: {
  label: string;
  x?: number;
  y?: number;
  z?: number;
  unit: string;
  digits: number;
}) {
  const f = (v?: number) =>
    v === undefined || !Number.isFinite(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(digits);
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="w-11 shrink-0 text-neutral-500">{label}</span>
      <span className="flex-1 text-neutral-100">
        {f(x)} {f(y)} {f(z)}
      </span>
      <span className="shrink-0 text-neutral-600">{unit}</span>
    </div>
  );
}

function vec(v: readonly number[], digits: number): string {
  return `[${v.map((n) => n.toFixed(digits)).join(', ')}]`;
}

/** Engine time is milliseconds since the source started, so show mm:ss.mmm. */
function formatT(t: number): string {
  const ms = Math.max(0, Math.floor(t));
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rem = ms % 1000;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(rem).padStart(3, '0')}`;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
