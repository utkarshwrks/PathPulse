package in.avinya.pathpulse;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Phase 15. Registered before super.onCreate so the bridge picks it up
        // with the rest of the plugins; registering afterwards leaves the web
        // side calling a plugin that does not exist yet, which surfaces as an
        // "unimplemented" rejection rather than as anything informative.
        registerPlugin(PathPulseSensorsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
