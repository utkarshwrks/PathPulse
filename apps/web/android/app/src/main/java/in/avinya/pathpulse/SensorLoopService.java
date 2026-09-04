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
        if (accel != null) sensorManager.registerListener(this, accel, IMU_PERIOD_US, sensorHandler);
        if (gyro != null) sensorManager.registerListener(this, gyro, IMU_PERIOD_US, sensorHandler);
        // ★ THE BAROMETER IS SLOW ON PURPOSE ★ 5 Hz, not 100. It measures a
        // quantity that changes over tens of seconds — a flyover ramp, a
        // multi-storey car park — and a MEMS barometer polled at 100 Hz
        // returns the same value a hundred times while drawing power to do it.
        if (pressure != null) {
            sensorManager.registerListener(this, pressure, 200_000, sensorHandler);
        }
    }

    private void registerLocation() {
        if (locationManager == null) return;
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "no fine location permission — GNSS will not be collected");
            return;
        }
        try {
            locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER, 0L, 0f, this, sensorThread.getLooper());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                locationManager.registerGnssStatusCallback(gnssCallback, sensorHandler);
            }
        } catch (SecurityException | IllegalArgumentException e) {
            Log.w(TAG, "could not start GNSS: " + e.getMessage());
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
            for (int i = 0; i < status.getSatelliteCount(); i++) {
                inView++;
                if (!status.usedInFix(i)) continue;
                String name = constellationName(status.getConstellationType(i));
                Integer previous = counts.get(name);
                counts.put(name, previous == null ? 1 : previous + 1);
            }
            synchronized (constellations) {
                constellations.clear();
                constellations.putAll(counts);
                satellitesInView = inView;
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

    @Override
    public void onLocationChanged(Location location) {
        lastLocation = location;
        lastLocationNanos = Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1
                ? location.getElapsedRealtimeNanos()
                : SystemClock.elapsedRealtimeNanos();
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
