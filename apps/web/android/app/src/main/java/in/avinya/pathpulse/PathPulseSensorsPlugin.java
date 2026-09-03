package in.avinya.pathpulse;

import android.content.Intent;
import android.hardware.Sensor;
import android.hardware.SensorManager;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;
import java.util.Map;

/**
 * Phase 15 — the bridge between the native sensor loop and the estimator.
 *
 * Deliberately thin. Everything that has to keep running when the WebView is
 * asleep lives in {@link SensorLoopService}; this class starts it, stops it,
 * and forwards its batches. A plugin that held state would lose that state
 * exactly when the WebView was throttled, which is the case it exists for.
 *
 * ★ WHY BATCHES AND NOT EVENTS ★
 * One bridge call per sample at 100 Hz is 100 JSON serialisations a second
 * across the JNI boundary, most of them while the screen is off and nobody is
 * looking at the result. A batch every 100 ms carries the same samples with
 * the same timestamps for a hundredth of the crossings — and because nav-core
 * is driven by `sample.t` rather than by arrival time, the estimate is
 * identical either way. See the long note in SensorLoopService.
 */
@CapacitorPlugin(name = "PathPulseSensors")
public class PathPulseSensorsPlugin extends Plugin {

    private boolean running = false;

    @PluginMethod
    public void start(PluginCall call) {
        if (running) {
            call.resolve(new JSObject().put("started", true).put("alreadyRunning", true));
            return;
        }

        SensorLoopService.setListener(this::emit);
        Intent intent = new Intent(getContext(), SensorLoopService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        running = true;
        call.resolve(new JSObject().put("started", true).put("alreadyRunning", false));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        SensorLoopService.setListener(null);
        getContext().stopService(new Intent(getContext(), SensorLoopService.class));
        running = false;
        call.resolve();
    }

    /**
     * What this device can actually do, asked before anything is started.
     *
     * ★ REPORTED, NOT ASSUMED ★ A phone with no gyroscope is a phone on which
     * dead reckoning draws a straight line through every corner, and the app
     * has a long-standing rule that it must say so rather than quietly
     * integrating zero. That rule needs an answer from the hardware.
     */
    @PluginMethod
    public void capabilities(PluginCall call) {
        SensorManager manager = (SensorManager) getContext().getSystemService(android.content.Context.SENSOR_SERVICE);
        JSObject out = new JSObject();
        out.put("available", true);
        out.put("hasAccelerometer", manager != null && manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null);
        out.put("hasGyroscope", manager != null && manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null);
        out.put("hasBarometer", manager != null && manager.getDefaultSensor(Sensor.TYPE_PRESSURE) != null);
        // GnssStatus, and therefore a measured constellation breakdown rather
        // than a labelled-simulated one, needs API 24.
        out.put("hasGnssStatus", Build.VERSION.SDK_INT >= Build.VERSION_CODES.N);
        out.put("running", running);
        call.resolve(out);
    }

    private void emit(List<Map<String, Object>> samples, Map<String, Object> status) {
        JSArray array = new JSArray();
        for (Map<String, Object> sample : samples) {
            array.put(toJs(sample));
        }
        JSObject payload = new JSObject();
        payload.put("samples", array);
        payload.put("status", toJs(status));
        notifyListeners("sensorBatch", payload);
    }

    @SuppressWarnings("unchecked")
    private static JSObject toJs(Map<String, Object> map) {
        JSObject out = new JSObject();
        for (Map.Entry<String, Object> entry : map.entrySet()) {
            Object value = entry.getValue();
            if (value instanceof Map) {
                out.put(entry.getKey(), toJs((Map<String, Object>) value));
            } else if (value instanceof Float) {
                // JSObject has no Float overload and would fall through to
                // toString(), delivering "9.81" as a string that the web side
                // would silently treat as NaN.
                out.put(entry.getKey(), ((Float) value).doubleValue());
            } else if (value instanceof Long) {
                out.put(entry.getKey(), ((Long) value).doubleValue());
            } else if (value instanceof Integer) {
                out.put(entry.getKey(), (Integer) value);
            } else if (value instanceof Double) {
                out.put(entry.getKey(), (Double) value);
            } else if (value instanceof Boolean) {
                out.put(entry.getKey(), (Boolean) value);
            } else if (value != null) {
                out.put(entry.getKey(), value.toString());
            }
        }
        return out;
    }
}
