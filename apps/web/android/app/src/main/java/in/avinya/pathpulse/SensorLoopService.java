package in.avinya.pathpulse;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Phase 15 — the sensor loop that survives the screen going off.
 *
 * ★ THE PROBLEM ★
 *
 * Android throttles a backgrounded WebView. With the screen off, the
 * DeviceMotion callbacks the web sensor source depends on fall from 10 Hz to
 * roughly 1 Hz, and eventually stop. That is not a degradation the estimator
 * can absorb: dead reckoning integrates what it is given, and a tenth of the
 * samples means a tenth of the evidence for every turn.
 *
 * It is also the exact situation a real drive is. Nobody holds a phone awake
 * and unlocked through a tunnel.
 *
 * ★ THE ARCHITECTURE, AND WHY IT IS NOT THE ONE THE GUIDE SUGGESTS ★
 *
 * The build guide offers three options and recommends the third — run the
 * estimator itself natively inside an embedded JavaScript engine, so that both
 * the sensors and the maths escape the WebView's throttling. That is a real
 * answer to the problem as stated, and it costs an embedded runtime, a second
 * execution environment to debug, and a bridge to keep in step.
 *
 * It is unnecessary here, because of a property nav-core already has and
 * asserts: THE ENGINE IS DETERMINISTIC AND DRIVEN BY SAMPLE TIMESTAMPS, NOT BY
 * WALL CLOCK. `packages/nav-core/test/invariants.test.ts` asserts byte-identical
 * output for identical input. So feeding it ten buffered samples in one burst
 * produces exactly the same estimate as feeding it ten samples at 10 Hz — the
 * arithmetic cannot tell the difference, because every step uses `sample.t`.
 *
 * That changes what the WebView has to do. It does not need to RUN at 10 Hz.
 * It needs to CONSUME 10 Hz of samples, and it can do that in bursts whenever
 * Android lets it wake. What is lost is the UI refresh rate — the marker
 * updates once a second instead of ten times — and the screen is off, so
 * nobody is looking at it. When the screen comes back on, the estimate is
 * already correct and current.
 *
 * So: sensors and GNSS are collected natively at full rate inside a foreground
 * service that Android will not throttle, buffered here, and handed to the
 * WebView in batches. One codebase, one estimator, no embedded runtime.
 *
 * ★ ON THE LANGUAGE ★
 * The guide's phase is titled "native Kotlin". This is Java. The substance is
 * the native collection loop and the foreground service; the language is not,
 * and adding a Kotlin toolchain to a Gradle build that currently works is risk
 * with no corresponding benefit. Porting this file is mechanical if a reason
 * ever appears.
 */
public class SensorLoopService extends Service implements SensorEventListener, LocationListener {

    public interface BatchListener {
        void onBatch(List<Map<String, Object>> samples, Map<String, Object> status);
    }

    private static final String TAG = "PathPulseSensors";
    private static final String CHANNEL_ID = "pathpulse_navigation";
    private static final int NOTIFICATION_ID = 1701;

    /**
     * Requested IMU period, microseconds. 10 ms is 100 Hz.
     *
     * A request, not a guarantee: SensorManager treats it as a hint and
     * delivers what the hardware and the current power state allow. Asking for
     * SENSOR_DELAY_FASTEST as the guide suggests can mean 400 Hz on a modern
     * handset, which is four times the data the 10 Hz estimator will ever use
     * and four times the battery to collect it.
     */
    private static final int IMU_PERIOD_US = 10_000;

    /** How often a batch is handed to the WebView, ms. */
    private static final long BATCH_INTERVAL_MS = 100;

    /**
     * Ceiling on the buffer, samples.
     *
     * At 100 Hz this is twenty seconds. If the WebView has not woken in twenty
     * seconds it is not coming back before Android kills something, and an
     * unbounded buffer would be the thing it kills. Oldest are dropped and the
     * count is reported, because silently losing samples is how a rate figure
     * becomes a lie.
     */
    private static final int MAX_BUFFERED = 2000;

    private static BatchListener listener;

    private SensorManager sensorManager;
    private LocationManager locationManager;
    private PowerManager.WakeLock wakeLock;
    private HandlerThread sensorThread;
    private Handler sensorHandler;
    private Handler batchHandler;

    private final List<Map<String, Object>> buffer = new ArrayList<>();
    private final float[] lastGyro = new float[3];
    private boolean haveGyro = false;
    private float lastPressureHpa = Float.NaN;
    private Location lastLocation = null;
    private long lastLocationNanos = 0;
    private final Map<String, Integer> constellations = new HashMap<>();
    private int satellitesInView = 0;
    private float meanCn0 = Float.NaN;
    private float cn0Spread = Float.NaN;
    private final float[] lastMag = new float[3];
    private boolean haveMag = false;

    private long imuCount = 0;
    private long gnssCount = 0;
    private long droppedSamples = 0;
    private long startedAtNanos = 0;

    /**
     * ★ ONE MONOTONIC CLOCK, CHOSEN ONCE ★
     *
     * `SensorEvent.timestamp` is nanoseconds on the elapsed-realtime clock.
     * `Location.getElapsedRealtimeNanos()` is the same clock. `System.currentTimeMillis()`
     * is a different one that jumps when the network corrects the time, and
     * mixing them is how a sample stream acquires a negative dt and sends the
     * position flying — which `NavigationEngine.update` explicitly guards
     * against and should never have to.
     *
     * Everything below is elapsed-realtime milliseconds. The wall-clock offset
     * is recorded once, at start, purely so a recording can be dated later.
     */
    private long bootEpochMs = 0;

    static void setListener(BatchListener l) {
        listener = l;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        bootEpochMs = System.currentTimeMillis() - SystemClock.elapsedRealtime();
        startedAtNanos = SystemClock.elapsedRealtimeNanos();

        createChannel();
        startForegroundCompat();
        acquireWakeLock();

        // ★ THE SENSOR CALLBACKS GET THEIR OWN THREAD ★
        // Delivered on the main looper they compete with the WebView's own
        // work, and at 100 Hz they lose: the samples arrive late and bunched,
        // which is exactly the jitter the estimator's dt handling exists to
        // survive and should not have to.
        sensorThread = new HandlerThread("pathpulse-sensors", android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);
        sensorThread.start();
        sensorHandler = new Handler(sensorThread.getLooper());
        batchHandler = new Handler(sensorThread.getLooper());

        registerSensors();
        registerLocation();
        batchHandler.postDelayed(batchRunnable, BATCH_INTERVAL_MS);
        Log.i(TAG, "sensor loop started");
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Navigation", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Keeps dead reckoning running with the screen off");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private void startForegroundCompat() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("PathPulse is navigating")
                .setContentText("Dead reckoning continues with the screen off")
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(pending)
                .build();

        // From Android 14 a foreground service must declare its type at start
        // as well as in the manifest, and mismatching the two is a crash on
        // launch rather than a warning.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void acquireWakeLock() {
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power == null) return;
        // PARTIAL keeps the CPU awake and lets the screen go off, which is the
        // entire point. A screen-on lock would keep the display lit for the
        // whole drive and flatten the battery to solve a problem nobody has.
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PathPulse::SensorLoop");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(4 * 60 * 60 * 1000L);
    }

    private void registerSensors() {
        if (sensorManager == null) return;
        Sensor accel = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        Sensor gyro = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        Sensor pressure = sensorManager.getDefaultSensor(Sensor.TYPE_PRESSURE);
        Sensor magnetometer = sensorManager.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD);
        if (accel != null) sensorManager.registerListener(this, accel, IMU_PERIOD_US, sensorHandler);
        if (gyro != null) sensorManager.registerListener(this, gyro, IMU_PERIOD_US, sensorHandler);
        // ★ THE BAROMETER IS SLOW ON PURPOSE ★ 5 Hz, not 100. It measures a
        // quantity that changes over tens of seconds — a flyover ramp, a
        // multi-storey car park — and a MEMS barometer polled at 100 Hz
        // returns the same value a hundred times while drawing power to do it.
        if (pressure != null) {
            sensorManager.registerListener(this, pressure, 200_000, sensorHandler);
        }
        // ★ THE MAGNETOMETER IS COLLECTED AND NOT USED, ON PURPOSE ★
        //
        // The build guide asks for it and it is cheap to read, so it is read —
        // at 10 Hz, since a magnetic field does not change faster than that in
        // a car. Nothing in the estimator consumes it, and that is a decision
        // rather than an omission: a vehicle is a steel box, its own body
        // distorts the field by tens of degrees, and the distortion changes
        // with heading. A magnetic heading in a car is not a heading, it is a
        // heading plus an unknown function of where you are pointing.
        //
        // AttitudeEstimator gets its vertical from gravity and its yaw from
        // the gyroscope, which has no such problem over the minutes an outage
        // lasts. What the magnetometer IS good for is spotting disturbance —
        // a field magnitude far from the local 25-65 uT is a nearby motor or a
        // steel bridge — and that is surfaced as a diagnostic rather than fed
        // to anything.
        if (magnetometer != null) {
            sensorManager.registerListener(this, magnetometer, 100_000, sensorHandler);
        }
    }

    private void registerLocation() {
        if (locationManager == null) return;
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "no fine location permission — GNSS will not be collected");
            return;
        }
        /*
         * ★ GPS_PROVIDER ALONE IS NOT "WHERE AM I" ★
         *
         * This asked for the raw GPS provider and nothing else. Outdoors with a
         * clear sky that is the right answer and the only one worth navigating
         * on. Indoors — which is where the app is opened, demonstrated and
         * judged — it delivers nothing at all, for minutes or for ever. The
         * WebView's own navigator.geolocation returned a 20 m fix in about a
         * second on the same handset at the same moment, because it asks the
         * fused provider, which blends WiFi and cell.
         *
         * So the symptom was: IMU at 127 Hz, GNSS at 0.00 Hz, mode stuck on
         * ACQUIRING, and a map that never moved. Every part of the estimator
         * was working and it had never been told where it was.
         *
         * Ask all three. GPS stays authoritative — see onLocationChanged, which
         * refuses to let a coarse network fix overwrite a recent satellite one —
         * but a coarse fix is still enough to put the marker in the right city
         * and start the map, which is the difference between "acquiring" and
         * "broken" to everyone watching.
         */
        boolean any = false;
        any |= requestFrom(LocationManager.GPS_PROVIDER);
        any |= requestFrom(LocationManager.NETWORK_PROVIDER);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            any |= requestFrom(LocationManager.FUSED_PROVIDER);
        }
        if (!any) Log.w(TAG, "no location provider accepted a request");

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                locationManager.registerGnssStatusCallback(gnssCallback, sensorHandler);
            }
        } catch (SecurityException | IllegalArgumentException e) {
            Log.w(TAG, "could not register GnssStatus: " + e.getMessage());
        }

        /*
         * Seed from the last known fix so the map can move before the first
         * live update arrives. Marked as seeded rather than measured: it may be
         * minutes old, and the engine must not mistake it for a fresh fix.
         */
        try {
            for (String p : new String[] { LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
                Location last = locationManager.getLastKnownLocation(p);
                if (last != null) {
                    onLocationChanged(last);
                    break;
                }
            }
        } catch (SecurityException | IllegalArgumentException ignored) {
            // Nothing to seed with is not an error.
        }
    }

    /** Request updates from one provider. Returns whether it took. */
    private boolean requestFrom(String provider) {
        try {
            if (!locationManager.isProviderEnabled(provider)) return false;
            locationManager.requestLocationUpdates(provider, 0L, 0f, this, sensorThread.getLooper());
            return true;
        } catch (SecurityException | IllegalArgumentException e) {
            // A provider this device does not have is normal, not a failure.
            Log.w(TAG, "provider " + provider + " unavailable: " + e.getMessage());
            return false;
        }
    }

    /**
     * ★ THE PHASE 9E PAYOFF ★
     *
     * The WebView reports a satellite COUNT and nothing else, so the
     * constellation breakdown has always had to be labelled as unavailable or
     * simulated — and the app says so, loudly, because inventing a NavIC count
     * for an ISRO-sponsored problem statement would be the worst possible
     * thing to be caught doing. `GnssStatus` reports the constellation of every
     * tracked satellite, so from here the number is measured.
     */
    private final GnssStatus.Callback gnssCallback = new GnssStatus.Callback() {
        @Override
        public void onSatelliteStatusChanged(GnssStatus status) {
            Map<String, Integer> counts = new HashMap<>();
            int inView = 0;
            // ★ C/N0 OVER THE SATELLITES ACTUALLY USED IN THE FIX ★
            // Averaging every satellite in view includes ones the receiver
            // already rejected, which is the population whose weakness is the
            // reason they were rejected — it would report the sky as worse
            // than the fix actually is, permanently.
            double sum = 0;
            double sumSq = 0;
            int used = 0;
            for (int i = 0; i < status.getSatelliteCount(); i++) {
                inView++;
                if (!status.usedInFix(i)) continue;
                String name = constellationName(status.getConstellationType(i));
                Integer previous = counts.get(name);
                counts.put(name, previous == null ? 1 : previous + 1);

                float cn0 = status.getCn0DbHz(i);
                if (!Float.isNaN(cn0) && cn0 > 0) {
                    sum += cn0;
                    sumSq += cn0 * cn0;
                    used++;
                }
            }
            synchronized (constellations) {
                constellations.clear();
                constellations.putAll(counts);
                satellitesInView = inView;
                if (used > 0) {
                    double mean = sum / used;
                    meanCn0 = (float) mean;
                    // Population standard deviation. Clamped at zero because
                    // floating point can make a variance of exactly zero come
                    // out very slightly negative, and sqrt of that is NaN.
                    cn0Spread = used > 1
                            ? (float) Math.sqrt(Math.max(0, sumSq / used - mean * mean))
                            : 0f;
                } else {
                    meanCn0 = Float.NaN;
                    cn0Spread = Float.NaN;
                }
            }
        }
    };

    private static String constellationName(int type) {
        switch (type) {
            case GnssStatus.CONSTELLATION_GPS: return "GPS";
            case GnssStatus.CONSTELLATION_GLONASS: return "GLONASS";
            case GnssStatus.CONSTELLATION_GALILEO: return "GALILEO";
            case GnssStatus.CONSTELLATION_BEIDOU: return "BEIDOU";
            case GnssStatus.CONSTELLATION_QZSS: return "QZSS";
            // The one this project is sponsored to care about. Android names it
            // IRNSS, which is NavIC's former name; the app says NavIC.
            case GnssStatus.CONSTELLATION_IRNSS: return "NAVIC";
            case GnssStatus.CONSTELLATION_SBAS: return "SBAS";
            default: return "UNKNOWN";
        }
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() == Sensor.TYPE_GYROSCOPE) {
            lastGyro[0] = event.values[0];
            lastGyro[1] = event.values[1];
            lastGyro[2] = event.values[2];
            haveGyro = true;
            return;
        }
        if (event.sensor.getType() == Sensor.TYPE_MAGNETIC_FIELD) {
            lastMag[0] = event.values[0];
            lastMag[1] = event.values[1];
            lastMag[2] = event.values[2];
            haveMag = true;
            return;
        }
        if (event.sensor.getType() == Sensor.TYPE_PRESSURE) {
            lastPressureHpa = event.values[0];
            return;
        }
        if (event.sensor.getType() != Sensor.TYPE_ACCELEROMETER) return;

        // ★ ONE SAMPLE PER ACCELEROMETER EVENT ★
        // Accelerometer and gyroscope arrive on independent schedules. Emitting
        // a sample per event of either would double the rate and half-fill
        // every sample; emitting only when both are fresh would drop most of
        // them. Pairing the newest gyro with each accelerometer event is what
        // DeviceMotion does in the browser, so the two sources produce the same
        // shape of stream and the engine cannot tell which it is reading.
        Map<String, Object> sample = new HashMap<>();
        sample.put("t", event.timestamp / 1_000_000L);

        Map<String, Object> imu = new HashMap<>();
        imu.put("ax", event.values[0]);
        imu.put("ay", event.values[1]);
        imu.put("az", event.values[2]);
        // ★ SIGN CONVENTION ★ nav-core documents that it wants the RIGHT-HAND
        // RULE rate exactly as the hardware reports it, and resolves yaw by
        // projecting onto measured gravity. Negating here to "make it a compass
        // rate" would be wrong twice: it assumes the phone is flat, and the
        // engine would then negate it again.
        imu.put("gx", haveGyro ? lastGyro[0] : 0f);
        imu.put("gy", haveGyro ? lastGyro[1] : 0f);
        imu.put("gz", haveGyro ? lastGyro[2] : 0f);
        imu.put("hasGyro", haveGyro);
        sample.put("imu", imu);

        // Attached to every sample rather than to its own, because the engine
        // reads pressure off whatever sample carries it and a barometer-only
        // sample would have no IMU for the estimator to step on.
        if (haveMag) {
            Map<String, Object> mag = new HashMap<>();
            mag.put("mx", lastMag[0]);
            mag.put("my", lastMag[1]);
            mag.put("mz", lastMag[2]);
            sample.put("mag", mag);
        }

        if (!Float.isNaN(lastPressureHpa)) {
            Map<String, Object> baro = new HashMap<>();
            baro.put("pressureHpa", lastPressureHpa);
            sample.put("baro", baro);
        }

        Location fix = lastLocation;
        if (fix != null) {
            Map<String, Object> gnss = new HashMap<>();
            gnss.put("lat", fix.getLatitude());
            gnss.put("lon", fix.getLongitude());
            gnss.put("accuracyM", fix.getAccuracy());
            if (fix.hasSpeed()) gnss.put("speedMps", fix.getSpeed());
            if (fix.hasBearing()) gnss.put("headingDeg", fix.getBearing());
            synchronized (constellations) {
                gnss.put("satCount", satellitesInView);
                if (!constellations.isEmpty()) {
                    gnss.put("constellations", new HashMap<>(constellations));
                }
                // Phase 13's Model 4 reads both. Neither alone separates a
                // reflected signal from a spoofed one: multipath lowers the
                // mean and WIDENS the spread, a spoofer raises the mean and
                // COLLAPSES it.
                if (!Float.isNaN(meanCn0)) gnss.put("meanCn0", meanCn0);
                if (!Float.isNaN(cn0Spread)) gnss.put("cn0Spread", cn0Spread);
            }
            // The fix's own timestamp, on the same monotonic clock, so the web
            // side can tell a held fix from a fresh one.
            gnss.put("fixT", lastLocationNanos / 1_000_000L);
            sample.put("gnss", gnss);
            // Attached once. A fix repeated on every one of the next hundred
            // IMU samples would look to the engine like a receiver fixing at
            // 100 Hz, and every adaptive-timeout decision downstream would be
            // made on a fiction.
            lastLocation = null;
        }

        synchronized (buffer) {
            if (buffer.size() >= MAX_BUFFERED) {
                buffer.remove(0);
                droppedSamples++;
            }
            buffer.add(sample);
        }
        imuCount++;
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // Nothing to do. Reported by the OS when calibration state changes; the
        // engine's own bias estimators are the answer to that, not a restart.
    }

    /** Elapsed-realtime nanos of the most recent GPS_PROVIDER fix, 0 if none. */
    private long lastGpsNanos = 0L;

    /** A satellite fix stays authoritative for this long against a coarse one. */
    private static final long GPS_HOLD_NANOS = 10_000_000_000L;

    @Override
    public void onLocationChanged(Location location) {
        final long nanos = Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1
                ? location.getElapsedRealtimeNanos()
                : SystemClock.elapsedRealtimeNanos();
        final boolean isGps = LocationManager.GPS_PROVIDER.equals(location.getProvider());

        /*
         * ★ NEVER LET A COARSE FIX OVERWRITE A GOOD ONE ★
         * Now that three providers are registered, they interleave. A network
         * fix is typically hundreds of metres wide and arrives on its own
         * schedule; letting one land on top of a 5 m satellite fix would drag
         * the estimate sideways and hand the road snapper a position on the
         * wrong street. While GPS is producing, GPS wins.
         */
        if (!isGps && lastGpsNanos != 0L && nanos - lastGpsNanos < GPS_HOLD_NANOS) return;

        if (isGps) lastGpsNanos = nanos;
        lastLocation = location;
        lastLocationNanos = nanos;
        gnssCount++;
    }

    @Override
    public void onProviderEnabled(String provider) { }

    @Override
    public void onProviderDisabled(String provider) { }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) { }

    private final Runnable batchRunnable = new Runnable() {
        @Override
        public void run() {
            List<Map<String, Object>> batch;
            synchronized (buffer) {
                if (buffer.isEmpty()) {
                    batch = null;
                } else {
                    batch = new ArrayList<>(buffer);
                    buffer.clear();
                }
            }
            BatchListener l = listener;
            if (batch != null && l != null) {
                l.onBatch(batch, status());
            }
            batchHandler.postDelayed(this, BATCH_INTERVAL_MS);
        }
    };

    Map<String, Object> status() {
        Map<String, Object> out = new HashMap<>();
        double elapsedS = (SystemClock.elapsedRealtimeNanos() - startedAtNanos) / 1e9;
        out.put("running", true);
        out.put("elapsedS", elapsedS);
        out.put("imuSamples", imuCount);
        out.put("gnssFixes", gnssCount);
        // The number the whole phase exists to move. Measured over the life of
        // the service, so a rate that collapses when the screen goes off shows
        // up here rather than being described as "should be fine".
        out.put("imuRateHz", elapsedS > 0 ? imuCount / elapsedS : 0.0);
        out.put("droppedSamples", droppedSamples);
        out.put("bootEpochMs", bootEpochMs);
        out.put("hasGyro", haveGyro);
        out.put("hasBaro", !Float.isNaN(lastPressureHpa));
        out.put("hasMag", haveMag);
        out.put("meanCn0", Float.isNaN(meanCn0) ? 0.0 : meanCn0);
        return out;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Restart if Android kills us for memory: a navigation loop that stops
        // silently mid-drive is the failure this whole service exists to avoid.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "sensor loop stopping");
        if (sensorManager != null) sensorManager.unregisterListener(this);
        if (locationManager != null) {
            try {
                locationManager.removeUpdates(this);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    locationManager.unregisterGnssStatusCallback(gnssCallback);
                }
            } catch (SecurityException ignored) {
                // Permission revoked while running. Nothing left to unregister.
            }
        }
        if (batchHandler != null) batchHandler.removeCallbacks(batchRunnable);
        if (sensorThread != null) sensorThread.quitSafely();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
