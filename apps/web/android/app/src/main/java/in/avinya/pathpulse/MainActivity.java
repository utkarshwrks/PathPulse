package in.avinya.pathpulse;

import android.os.Build;
import android.os.Bundle;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import com.getcapacitor.BridgeActivity;

/**
 * ★ WHY THIS ACTIVITY IS NO LONGER EMPTY ★
 *
 * Two separate reasons, one per lifecycle hook.
 *
 * onCreate — the native sensors plugin has to be registered before
 * super.onCreate so the bridge picks it up with the rest of the plugins;
 * registering afterwards leaves the web side calling a plugin that does not
 * exist yet, which surfaces as an "unimplemented" rejection rather than as
 * anything informative.
 *
 * onStart — the offline map, the aeroplane-mode moment the whole demo builds
 * to, needs a service worker to serve cached tiles. Inside the APK it never
 * registered. Measured on the device over adb, with the page served from
 * https://localhost:
 *
 *     TypeError: Failed to register a ServiceWorker for scope
 *     ('https://localhost/') with script ('https://localhost/sw.js'):
 *     An unknown error occurred when fetching the script.
 *
 * and `navigator.serviceWorker.getRegistrations()` stayed empty — while a plain
 * `fetch('/sw.js')` from the same page returned 200 with the right MIME type.
 * That combination is the tell: the page's own requests go through Capacitor's
 * WebViewLocalServer, but a service worker's requests are issued by a separate
 * WebView subsystem that has its own interceptor, and Capacitor 6 does not wire
 * one up — there is not a single reference to ServiceWorker in its Bridge. So
 * the worker script was fetched by something that had never been told how to
 * read the app's bundled assets, and the fetch failed with no useful error.
 *
 * Delegating that interceptor to the very same local server the main WebView
 * already uses is the whole fix. It adds no new asset path and no new origin:
 * requests that used to fail now resolve exactly as the page's own do.
 *
 * ServiceWorkerController is API 24+; minSdk here is 22, so it is guarded. On
 * 22 and 23 the offline panel simply reports the worker as unavailable, which
 * it already knows how to do.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Phase 15. See the class comment for why this precedes super.
        registerPlugin(PathPulseSensorsPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onStart() {
        super.onStart();

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;

        ServiceWorkerController.getInstance()
            .setServiceWorkerClient(
                new ServiceWorkerClient() {
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                        // Same interception the page's own requests get. Returning
                        // null lets the WebView fall through to the network, which
                        // is what tile requests need.
                        return getBridge().getLocalServer().shouldInterceptRequest(request);
                    }
                }
            );
    }
}
