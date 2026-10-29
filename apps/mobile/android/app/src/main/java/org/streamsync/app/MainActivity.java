package org.streamsync.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setAllowFileAccess(true);
            // Keep popups and target="_blank" inside the same app webview
            settings.setSupportMultipleWindows(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(true);
        }
    }

    @Override
    public void onBackPressed() {
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            // Check if StreamSync JavaScript handles the back action (close sheet/modal or leave theater room)
            webView.evaluateJavascript("window.handleAppBack ? window.handleAppBack() : 'EXIT'", value -> {
                if ("\"HANDLED\"".equals(value) || "true".equals(value)) {
                    // Handled gracefully inside the StreamSync UI
                    return;
                }
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    super.onBackPressed();
                }
            });
            return;
        }
        super.onBackPressed();
    }
}
