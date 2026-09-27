package com.bebranova.nocturne;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NocturneLanPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
