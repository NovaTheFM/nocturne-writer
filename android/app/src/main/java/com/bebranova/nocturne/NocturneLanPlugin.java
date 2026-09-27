package com.bebranova.nocturne;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
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
    private WebView printView;

    @PluginMethod
    public void printHtml(PluginCall call) {
        String html = call.getString("html");
        if (html == null || html.length() > 40 * 1024 * 1024) { call.reject("Invalid print document."); return; }
        getActivity().runOnUiThread(() -> {
            if (printView != null) printView.destroy();
            printView = new WebView(getActivity());
            printView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    PrintManager printer = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                    String title = call.getString("title", "Nocturne Writer");
                    printer.print(title, view.createPrintDocumentAdapter(title), new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
                    call.resolve();
                }
            });
            printView.loadDataWithBaseURL("http://localhost/", html, "text/html", "UTF-8", null);
        });
    }

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
    protected void handleOnDestroy() { stopDiscovery(); if (printView != null) printView.destroy(); }
}
