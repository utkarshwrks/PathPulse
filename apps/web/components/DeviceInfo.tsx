'use client';

import { useEffect, useState } from 'react';
import { detectPlatform, type PlatformInfo } from '@/lib/platform';

interface DeviceInfoProps {
  imuHz: number;
  gnssHz: number;
  sourceName: string;
  onClose: () => void;
}

/**
 * Debug screen proving what the app is actually running on and what the
 * sensors are actually doing.
 *
 * Exists because "it works on my phone" is not evidence. Phase 5 grows this
 * into the full anti-fake debug panel with live raw sensor values.
 */
export default function DeviceInfo({ imuHz, gnssHz, sourceName, onClose }: DeviceInfoProps) {
  const [info, setInfo] = useState<PlatformInfo | null>(null);
  const [permission, setPermission] = useState<string>('checking…');

  useEffect(() => {
    void detectPlatform().then(setInfo);
    void (async () => {
      try {
        const { Geolocation } = await import('@capacitor/geolocation');
        const p = await Geolocation.checkPermissions();
        setPermission(p.location);
      } catch {
        if (typeof navigator !== 'undefined' && navigator.permissions) {
          try {
            const st = await navigator.permissions.query({ name: 'geolocation' });
            setPermission(st.state);
          } catch {
            setPermission('unknown');
          }
        } else {
          setPermission('unknown');
        }
      }
    })();
  }, []);

  return (
    <div className="absolute inset-0 z-40 overflow-auto bg-black/90 p-5 backdrop-blur">
      <div className="mx-auto max-w-md">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-neutral-100">Device Info</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/15 px-3 py-1 text-xs text-neutral-300"
          >
            Close
          </button>
        </div>

        <Section title="Build">
          <Row k="version" v={process.env.NEXT_PUBLIC_BUILD_ID ?? 'unknown'} />
          <Row
            k="built"
            v={
              process.env.NEXT_PUBLIC_BUILD_TIME
                ? new Date(process.env.NEXT_PUBLIC_BUILD_TIME).toLocaleString()
                : 'unknown'
            }
          />
          <Row k="phase" v={process.env.NEXT_PUBLIC_PHASE ?? 'unknown'} />
        </Section>

        <Section title="Platform">
          <Row k="running as" v={info ? (info.isNative ? 'Native APK' : 'Web browser') : '…'} />
          <Row k="platform" v={info?.platform ?? '…'} />
          {info?.manufacturer ? <Row k="manufacturer" v={info.manufacturer} /> : null}
          {info?.model ? <Row k="model" v={info.model} /> : null}
          {info?.osVersion ? <Row k="os version" v={info.osVersion} /> : null}
          {info?.webViewVersion ? <Row k="webview" v={info.webViewVersion} /> : null}
          <Row k="secure context" v={info ? String(info.isSecureContext) : '…'} />
        </Section>

        <Section title="Sensors">
          <Row k="active source" v={sourceName || '—'} />
          <Row k="imu rate" v={`${imuHz.toFixed(1)} Hz`} />
          <Row k="gnss rate" v={`${gnssHz.toFixed(2)} Hz`} />
          <Row k="location permission" v={permission} />
        </Section>

        <Section title="Known limits">
          <p className="text-[11px] leading-relaxed text-neutral-500">
            IMU here comes from the WebView&apos;s DeviceMotion, so the rate is whatever the
            WebView allows rather than SENSOR_DELAY_FASTEST, and it is throttled when the
            screen is off. Satellite count and the per-constellation breakdown are not
            exposed either, so the NavIC figures in Debug → SENSORS are labelled
            SIMULATED whenever they come from the simulator and UNAVAILABLE on this
            hardware. All of it needs a native Kotlin sensor loop and the GnssStatus
            API — that is Phase 15.
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-3 rounded-xl border border-white/10 bg-neutral-900/70 p-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
        {title}
      </h3>
      <dl className="tabular space-y-1 font-mono text-[11px]">{children}</dl>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-neutral-500">{k}</dt>
      <dd className="break-all text-right text-neutral-200">{v}</dd>
    </div>
  );
}
