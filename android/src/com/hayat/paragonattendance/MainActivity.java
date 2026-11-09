package com.hayat.paragonattendance;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.inputmethod.EditorInfo;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Paragon Attendance - Android app.
 * Asks once for the server address (office PC on the LAN, e.g. http://192.168.1.10:8001,
 * or the online URL) and then shows the Paragon web app full screen.
 * JS bridge "ParagonApp": saveFile, print, changeServer, version.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "paragon";
    private static final String KEY_URL = "server_url";
    private static final int NAVY = 0xFF123A5E;
    private static final int NAVY_DARK = 0xFF0D2B47;
    private static final int REQ_FILE = 11;
    private android.webkit.ValueCallback<Uri[]> fileCallback;

    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView web;
    private ProgressBar bar;
    private String serverUrl;
    private boolean showingError = false;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.setStatusBarColor(NAVY_DARK);
        w.setNavigationBarColor(Color.WHITE);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        root = new FrameLayout(this);
        root.setBackgroundColor(0xFFF3F6FA);
        root.setFitsSystemWindows(true);
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::handleBack);
        }
        // The server address is built into the app (AppConfig.SERVER_URL), so people only see the login.
        serverUrl = prefs.getString(KEY_URL, null);
        if (serverUrl == null || serverUrl.isEmpty()) serverUrl = AppConfig.SERVER_URL;
        if (serverUrl == null || serverUrl.isEmpty()) showSetup(null);
        else showWeb(savedInstanceState);
    }

    // ------------------------------------------------------------------ helpers
    private int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private GradientDrawable rounded(int color, float radiusDp, int strokeColor) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(radiusDp));
        if (strokeColor != 0) g.setStroke(dp(1), strokeColor);
        return g;
    }

    private Button button(String text, boolean primary) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(16);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(primary ? Color.WHITE : NAVY);
        b.setBackground(rounded(primary ? NAVY : Color.WHITE, 10, primary ? 0 : 0xFFCFD8E3));
        b.setPadding(dp(16), dp(12), dp(16), dp(12));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(12);
        b.setLayoutParams(lp);
        return b;
    }

    private TextView text(String s, float size, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(size);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    static String normalize(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return "";
        if (!s.startsWith("http://") && !s.startsWith("https://")) {
            // bare IP / host: LAN edition default port 8001
            boolean hasPort = s.replaceFirst("^\\[.*\\]", "").contains(":");
            boolean isIp = s.matches("^\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?(/.*)?$");
            s = (isIp ? "http://" : "https://") + s;
            if (isIp && !hasPort) s = s.replaceFirst("^(http://[^/]+)", "$1:8001");
        }
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    // ------------------------------------------------------------------ setup screen
    private void showSetup(String prefill) {
        showingError = false;
        if (web != null) { root.removeAllViews(); web.destroy(); web = null; }
        root.removeAllViews();
        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(24), dp(40), dp(24), dp(24));
        col.setGravity(Gravity.CENTER_HORIZONTAL);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.mipmap.ic_launcher);
        col.addView(logo, new LinearLayout.LayoutParams(dp(88), dp(88)));
        TextView brand = text("PARAGON", 26, NAVY, true);
        brand.setLetterSpacing(0.15f);
        brand.setPadding(0, dp(14), 0, 0);
        col.addView(brand);
        TextView sub = text("Attendance & Payroll", 15, 0xFF6B7785, false);
        sub.setPadding(0, 0, 0, dp(24));
        col.addView(sub);

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(18), dp(18), dp(18), dp(18));
        card.setBackground(rounded(Color.WHITE, 14, 0xFFDDE3EA));
        TextView lbl = text("Server address", 14, 0xFF1D2733, true);
        card.addView(lbl);
        final EditText input = new EditText(this);
        input.setHint("192.168.1.10:8001");
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        input.setTextSize(18);
        input.setBackground(rounded(0xFFF7F9FB, 8, 0xFFCFD8E3));
        input.setPadding(dp(12), dp(12), dp(12), dp(12));
        String cur = prefill != null ? prefill : prefs.getString(KEY_URL, "");
        input.setText(cur == null ? "" : cur.replaceFirst("^http://", ""));
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ilp.topMargin = dp(8);
        card.addView(input, ilp);
        TextView help = text("• Office Wi-Fi: type the address shown on the “This PC” tab on the server PC, e.g. 192.168.1.10:8001\n"
                + "• Online version: type its web address, e.g. paragon.yourdomain.com", 13, 0xFF6B7785, false);
        help.setPadding(0, dp(10), 0, 0);
        help.setLineSpacing(dp(2), 1f);
        card.addView(help);
        final TextView status = text("", 14, 0xFFC62828, false);
        status.setPadding(0, dp(10), 0, 0);
        card.addView(status);
        final Button connect = button("Connect", true);
        card.addView(connect);
        col.addView(card, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView foot = text("Your phone must be on the same Wi-Fi as the office PC.", 13, 0xFF6B7785, false);
        foot.setGravity(Gravity.CENTER);
        foot.setPadding(0, dp(18), 0, 0);
        col.addView(foot);

        sv.addView(col);
        root.addView(sv);

        View.OnClickListener go = v -> {
            final String url = normalize(input.getText().toString());
            if (url.isEmpty()) { status.setText("Please type the server address."); return; }
            connect.setEnabled(false);
            connect.setText("Checking…");
            status.setTextColor(0xFF6B7785);
            status.setText("Connecting to " + url + " …");
            new Thread(() -> {
                final String err = testServer(url);
                ui.post(() -> {
                    connect.setEnabled(true);
                    connect.setText("Connect");
                    if (err == null) {
                        prefs.edit().putString(KEY_URL, url).apply();
                        serverUrl = url;
                        showWeb(null);
                    } else {
                        status.setTextColor(0xFFC62828);
                        status.setText(err);
                        new AlertDialog.Builder(this)
                                .setTitle("Could not reach the server")
                                .setMessage(err + "\n\nCheck that the phone is on the office Wi-Fi and the server PC is on.")
                                .setPositiveButton("Try again", null)
                                .setNegativeButton("Save anyway", (d, i) -> {
                                    prefs.edit().putString(KEY_URL, url).apply();
                                    serverUrl = url;
                                    showWeb(null);
                                }).show();
                    }
                });
            }).start();
        };
        connect.setOnClickListener(go);
        input.setOnEditorActionListener((v, actionId, e) -> { go.onClick(v); return true; });
    }

    /** returns null if the address is a Paragon server, otherwise an error message */
    private String testServer(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url + "/api/").openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(6000);
            int code = c.getResponseCode();
            InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
            StringBuilder sb = new StringBuilder();
            if (in != null) {
                byte[] buf = new byte[2048];
                int n;
                while ((n = in.read(buf)) > 0 && sb.length() < 4000) sb.append(new String(buf, 0, n, "UTF-8"));
            }
            if (code == 200 && sb.toString().contains("Paragon")) return null;
            return "That address answered, but it isn't a Paragon server (code " + code + ").";
        } catch (java.net.SocketTimeoutException e) {
            return "No answer from " + url + " (timed out).";
        } catch (Exception e) {
            return "Cannot connect to " + url + " (" + e.getClass().getSimpleName() + ").";
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ------------------------------------------------------------------ web app
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void showWeb(Bundle state) {
        showingError = false;
        root.removeAllViews();
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " ParagonApp/1.0");
        web.addJavascriptInterface(new Bridge(), "ParagonApp");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    Intent i = params.createIntent();
                    i.setType("*/*");
                    startActivityForResult(i, REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "Cannot open the file picker", Toast.LENGTH_LONG).show();
                    return false;
                }
                return true;
            }
            @Override public void onProgressChanged(WebView view, int p) {
                if (bar != null) { bar.setProgress(p); bar.setVisibility(p < 100 ? View.VISIBLE : View.GONE); }
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                Uri base = Uri.parse(serverUrl);
                if (u.getHost() != null && u.getHost().equalsIgnoreCase(base.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true; // Google Drive links, WhatsApp etc. open outside
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (splash != null) { root.removeView(splash); splash = null; }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showError(String.valueOf(err.getDescription()));
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgressTintList(android.content.res.ColorStateList.valueOf(0xFFC62828));
        root.addView(bar, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP));
        showSplash();
        if (state != null && web.restoreState(state) != null) return;
        web.loadUrl(serverUrl + "/");
    }

    private View splash;

    private void showSplash() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(NAVY_DARK);
        box.setClickable(true);
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.mipmap.ic_launcher);
        box.addView(logo, new LinearLayout.LayoutParams(dp(84), dp(84)));
        TextView t = text("Paragon", 30, Color.WHITE, true);
        t.setPadding(0, dp(16), 0, dp(4));
        box.addView(t);
        TextView s2 = text("Attendance & payroll", 14, 0xFF9FB6CC, false);
        box.addView(s2);
        ProgressBar pb = new ProgressBar(this);
        pb.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(Color.WHITE));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(28), dp(28));
        lp.topMargin = dp(28);
        box.addView(pb, lp);
        splash = box;
        root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        ui.postDelayed(() -> { if (splash != null) { root.removeView(splash); splash = null; } }, 15000);
    }

    private void showError(String detail) {
        if (showingError) return;
        showingError = true;
        ui.post(() -> {
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setGravity(Gravity.CENTER);
            box.setPadding(dp(28), dp(28), dp(28), dp(28));
            box.setBackgroundColor(0xFFF3F6FA);
            box.setClickable(true);
            TextView t = text("Can't reach the Paragon server", 20, NAVY, true);
            t.setGravity(Gravity.CENTER);
            box.addView(t);
            TextView m = text("Check that mobile data or Wi-Fi is on, then try again.\n\n(" + detail + ")", 14, 0xFF4A5560, false);
            m.setGravity(Gravity.CENTER);
            m.setPadding(0, dp(14), 0, dp(8));
            box.addView(m);
            Button retry = button("Try again", true);
            retry.setOnClickListener(v -> { root.removeView(box); showingError = false; web.reload(); });
            box.addView(retry);
            if (splash != null) { root.removeView(splash); splash = null; }
            Button change = button("Server settings", false);
            change.setOnClickListener(v -> showSetup(serverUrl));
            box.addView(change);
            root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        });
    }

    private void handleBack() {
        if (web != null && !showingError && web.canGoBack()) web.goBack();
        else finish();
    }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { handleBack(); }

    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    @Override protected void onPause() { super.onPause(); if (web != null) web.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }

    // ------------------------------------------------------------------ JS bridge
    private class Bridge {
        @JavascriptInterface public String version() { return "1.0.0"; }

        @JavascriptInterface public void changeServer() {
            ui.post(() -> new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Change server address?")
                    .setMessage("Now connected to:\n" + serverUrl)
                    .setPositiveButton("Change", (d, i) -> showSetup(serverUrl))
                    .setNegativeButton("Cancel", null).show());
        }

        @JavascriptInterface public void print(final String title) {
            ui.post(() -> {
                PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                String name = (title == null || title.isEmpty()) ? "Paragon" : title;
                pm.print(name, web.createPrintDocumentAdapter(name), new PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
            });
        }

        @JavascriptInterface public void saveFile(final String name, final String mime, final String base64) {
            final String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            new Thread(() -> {
                String msg;
                try {
                    byte[] data = Base64.decode(base64, Base64.DEFAULT);
                    if (Build.VERSION.SDK_INT >= 29) {
                        ContentValues cv = new ContentValues();
                        cv.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                        cv.put(MediaStore.Downloads.MIME_TYPE, mime);
                        cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Paragon");
                        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                        try (OutputStream os = getContentResolver().openOutputStream(uri)) { os.write(data); }
                        msg = "Saved to Downloads/Paragon/" + safe;
                    } else {
                        if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                            ui.post(() -> requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 7));
                            msg = "Allow storage permission, then tap download again.";
                        } else {
                            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Paragon");
                            dir.mkdirs();
                            try (FileOutputStream fo = new FileOutputStream(new File(dir, safe))) { fo.write(data); }
                            msg = "Saved to Downloads/Paragon/" + safe;
                        }
                    }
                } catch (Exception e) {
                    msg = "Could not save file: " + e.getMessage();
                }
                final String m = msg;
                ui.post(() -> Toast.makeText(MainActivity.this, m, Toast.LENGTH_LONG).show());
            }).start();
        }
    }
}
