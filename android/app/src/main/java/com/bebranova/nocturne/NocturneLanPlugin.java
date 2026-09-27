package com.bebranova.nocturne;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NocturneLan")
public class NocturneLanPlugin extends Plugin {
    private NsdManager manager;
    private NsdManager.DiscoveryListener listener;
    private WifiManager.MulticastLock multicast;

    @PluginMethod
    public void discover(PluginCall call) {
        stopDiscovery();
        manager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        multicast = wifi.createMulticastLock("nocturne-lan-discovery");
        multicast.setReferenceCounted(false);
        multicast.acquire();
        listener = new NsdManager.DiscoveryListener() {
            public void onDiscoveryStarted(String type) {}
            public void onDiscoveryStopped(String type) {}
            public void onServiceLost(NsdServiceInfo info) {}
            public void onStartDiscoveryFailed(String type, int error) { stopDiscovery(); }
            public void onStopDiscoveryFailed(String type, int error) { stopDiscovery(); }
            public void onServiceFound(NsdServiceInfo service) {
                if (!service.getServiceType().contains("_nocturne-sync._tcp")) return;
                manager.resolveService(service, new NsdManager.ResolveListener() {
                    public void onResolveFailed(NsdServiceInfo info, int error) {}
                    public void onServiceResolved(NsdServiceInfo info) {
                        if (info.getHost() == null) return;
                        JSObject device = new JSObject();
                        device.put("host", info.getHost().getHostAddress());
                        device.put("port", String.valueOf(info.getPort()));
                        device.put("deviceName", info.getServiceName().replace("Nocturne Sync - ", ""));
                        notifyListeners("deviceFound", device);
                    }
                });
            }
        };
        manager.discoverServices("_nocturne-sync._tcp.", NsdManager.PROTOCOL_DNS_SD, listener);
        new Handler(Looper.getMainLooper()).postDelayed(this::stopDiscovery, 12000);
        call.resolve();
    }

    private void stopDiscovery() {
        NsdManager.DiscoveryListener current = listener;
        listener = null;
        if (manager != null && current != null) {
            try { manager.stopServiceDiscovery(current); } catch (Exception ignored) {}
        }
        if (multicast != null && multicast.isHeld()) multicast.release();
    }

    @Override
    protected void handleOnDestroy() { stopDiscovery(); }
}
