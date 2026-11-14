package es.locometopa.acelisttv;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import org.json.JSONObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Abre canales en otras apps de la tele: Ace Player (Ace Stream), VLC u otra app
 * que acepte enlaces acestream:// (AceServe, etc.).
 */
@CapacitorPlugin(name = "AceListNativo")
public class AceListNativoPlugin extends Plugin {

    private static final String[] ACESTREAM = {
        "org.acestream.media.atv", "org.acestream.media", "org.acestream.core.atv",
        "org.acestream.core", "org.acestream.live", "org.acestream.node"
    };
    // AceServe y HttpAceServeProxy: apps no oficiales que gestionan enlaces acestream:// con su propio motor
    private static final String[] ACESERVE = { "org.free.aceserve", "com.jopsis.httpaceserveproxy" };
    private static final String[] VLC = { "org.videolan.vlc", "org.videolan.vlc.betav7neon" };

    private ServidorMovil servidor;

    // ---------- panel del móvil ----------

    @PluginMethod
    public void iniciarServidor(PluginCall call) {
        String token = call.getString("token", "");
        int puerto = call.getInt("puerto", 8095);
        if (token == null || token.length() < 6) {
            call.reject("Clave no válida");
            return;
        }
        if (servidor == null) {
            servidor = new ServidorMovil(getContext().getAssets(), (id, method, path, body) -> {
                JSObject peticion = new JSObject();
                peticion.put("id", id);
                peticion.put("method", method);
                peticion.put("path", path);
                peticion.put("body", body);
                notifyListeners("peticion", peticion);
            });
            servidor.setInstalador((datos, largo) -> {
                try {
                    File f = guardar(datos, largo);
                    return lanzarInstalador(f);
                } catch (Exception e) {
                    return "No se pudo guardar la APK: " + e.getMessage();
                }
            });
        }
        try {
            int p = servidor.iniciar(puerto, token);
            JSObject r = new JSObject();
            r.put("ip", ServidorMovil.ipLocal());
            r.put("puerto", p);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("No se pudo abrir el puerto " + puerto + ": " + e.getMessage());
        }
    }

    @PluginMethod
    public void detenerServidor(PluginCall call) {
        if (servidor != null) servidor.detener();
        call.resolve();
    }

    @PluginMethod
    public void responder(PluginCall call) {
        if (servidor != null) {
            servidor.responder(call.getString("id", ""), call.getInt("status", 200), call.getString("body", "{}"));
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (servidor != null) servidor.detener();
        super.handleOnDestroy();
    }

    // ---------- reproductor nativo ----------

    @PluginMethod
    public void reproducir(PluginCall call) {
        JSArray items = call.getArray("items");
        ArrayList<String> ids = new ArrayList<>();
        ArrayList<String> titulos = new ArrayList<>();
        ArrayList<String> urls = new ArrayList<>();
        ArrayList<String> enlaces = new ArrayList<>();
        try {
            for (int i = 0; items != null && i < items.length(); i++) {
                JSONObject o = items.getJSONObject(i);
                ids.add(o.getString("id"));
                titulos.add(o.optString("title", o.getString("id")));
                urls.add(o.optString("url", ""));
                enlaces.add(o.optString("enlaces", ""));
            }
        } catch (Exception e) {
            call.reject("Lista de canales no válida");
            return;
        }
        if (ids.isEmpty()) { call.reject("No hay canal que reproducir"); return; }
        Intent intent = new Intent(getContext(), ReproductorActivity.class);
        intent.putStringArrayListExtra(ReproductorActivity.EXTRA_IDS, ids);
        intent.putStringArrayListExtra(ReproductorActivity.EXTRA_TITULOS, titulos);
        intent.putStringArrayListExtra(ReproductorActivity.EXTRA_URLS, urls);
        intent.putStringArrayListExtra(ReproductorActivity.EXTRA_ENLACES, enlaces);
        intent.putExtra(ReproductorActivity.EXTRA_INDICE, Math.max(0, Math.min(ids.size() - 1, call.getInt("index", 0))));
        intent.putExtra(ReproductorActivity.EXTRA_MOTOR, call.getString("motor", "http://127.0.0.1:6878"));
        intent.putExtra(ReproductorActivity.EXTRA_FORMATO, call.getString("formato", "ts"));
        intent.putExtra(ReproductorActivity.EXTRA_BLOQUEO, call.getString("bloqueo", ""));
        getActivity().startActivity(intent);
        call.resolve();
    }

    // Lo que el reproductor aprendió de cada enlace (arrancó o no, peers). Se devuelve y se borra.
    @PluginMethod
    public void resultadosReproductor(PluginCall call) {
        android.content.SharedPreferences sp = getContext().getSharedPreferences(ReproductorActivity.PREFS, android.content.Context.MODE_PRIVATE);
        String r = sp.getString("resultados", "[]");
        sp.edit().remove("resultados").apply();
        JSObject res = new JSObject();
        res.put("resultados", r);
        res.put("formato", sp.getString("formato", ""));
        call.resolve(res);
    }

    // Abre otra app por su paquete (p. ej. 1.1.1.1 de Cloudflare)
    @PluginMethod
    public void abrirApp(PluginCall call) {
        String pkg = call.getString("paquete", "");
        PackageManager pm = getContext().getPackageManager();
        Intent i = pm.getLeanbackLaunchIntentForPackage(pkg);
        if (i == null) i = pm.getLaunchIntentForPackage(pkg);
        if (i == null) { call.reject("No está instalada", "NO_APP"); return; }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().startActivity(i);
        call.resolve();
    }

    /** Vacía la caché del WebView y los archivos temporales de la app (la APK de una actualización ya instalada, etc.). */
    @PluginMethod
    public void limpiarCache(PluginCall call) {
        long antes = 0;
        File cache = getContext().getCacheDir();
        File[] fs = cache != null ? cache.listFiles() : null;
        if (fs != null) {
            for (File f : fs) {
                if (f.isFile()) { antes += f.length(); f.delete(); }
            }
        }
        final long liberado = antes;
        getActivity().runOnUiThread(() -> {
            try { getBridge().getWebView().clearCache(true); } catch (Exception ignored) { }
            JSObject r = new JSObject();
            r.put("bytes", liberado);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void instalada(PluginCall call) {
        JSObject r = new JSObject();
        r.put("instalada", installed(call.getString("paquete", "")));
        call.resolve(r);
    }

    // ---------- actualizar la app ----------

    private File guardar(InputStream datos, long largo) throws IOException {
        File f = new File(getContext().getCacheDir(), "actualizacion.apk");
        try (OutputStream o = new FileOutputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            long falta = largo;
            while (falta != 0) {
                int n = datos.read(buf, 0, (int) Math.min(buf.length, falta < 0 ? buf.length : falta));
                if (n < 0) { if (falta > 0) throw new IOException("descarga cortada"); break; }
                o.write(buf, 0, n);
                if (falta > 0) falta -= n;
            }
        }
        return f;
    }

    /** Abre el instalador de Android con la APK. Devuelve null si se ha abierto, o el motivo si no. */
    private String lanzarInstalador(File f) {
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.getPackageManager().canRequestPackageInstalls()) {
            Intent ajustes = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
            ajustes.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { ctx.startActivity(ajustes); } catch (Exception ignored) { }
            return "PERMISO";
        }
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
            return null;
        } catch (ActivityNotFoundException e) {
            return "La tele no tiene instalador de apps";
        }
    }

    /** Descarga la APK nueva y abre el instalador. */
    @PluginMethod
    public void actualizar(PluginCall call) {
        final String url = call.getString("url", "");
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(20000);
                c.setReadTimeout(60000);
                c.setInstanceFollowRedirects(true);
                if (c.getResponseCode() != 200) { call.reject("La descarga ha fallado (HTTP " + c.getResponseCode() + ")"); return; }
                File f;
                try (InputStream in = c.getInputStream()) { f = guardar(in, c.getContentLengthLong()); }
                finally { c.disconnect(); }
                String err = lanzarInstalador(f);
                if (err == null) call.resolve();
                else call.reject(err, err);
            } catch (Exception e) {
                call.reject("No se pudo descargar: " + e.getMessage());
            }
        }).start();
    }

    // ---------- VPN ----------

    /** ¿La conexión actual pasa por una VPN (WARP, Proton VPN u otra)? */
    @PluginMethod
    public void vpn(PluginCall call) {
        JSObject r = new JSObject();
        boolean activa = false;
        try {
            ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
            Network n = cm.getActiveNetwork();
            NetworkCapabilities nc = n == null ? null : cm.getNetworkCapabilities(n);
            activa = nc != null && nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
        } catch (Exception e) { /* sin permiso o sin red */ }
        r.put("activa", activa);
        call.resolve(r);
    }

    /** Abre la ficha de una app en la Play Store de la tele. */
    @PluginMethod
    public void tienda(PluginCall call) {
        String pkg = call.getString("paquete", "");
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getActivity().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No hay tienda de apps", "NO_STORE");
        }
    }

    // ---------- abrir canales en otras apps ----------

    private boolean installed(String pkg) {
        try {
            getContext().getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private String firstInstalled(String[] pkgs) {
        for (String p : pkgs) if (installed(p)) return p;
        return null;
    }

    private int acestreamHandlers() {
        Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("acestream://0000000000000000000000000000000000000000"));
        return getContext().getPackageManager().queryIntentActivities(probe, 0).size();
    }

    @PluginMethod
    public void apps(PluginCall call) {
        JSObject r = new JSObject();
        r.put("acestream", firstInstalled(ACESTREAM));
        r.put("vlc", firstInstalled(VLC));
        r.put("aceserve", firstInstalled(ACESERVE));
        r.put("enlacesAcestream", acestreamHandlers());
        call.resolve(r);
    }

    @PluginMethod
    public void abrir(PluginCall call) {
        String app = call.getString("app", "elegir");
        String id = call.getString("id", "");
        String url = call.getString("url", "");
        Intent intent;
        boolean chooser = false;
        switch (app) {
            case "aceplayer":
            case "acestream": {
                // API oficial de Ace Stream 3.1.43+; type 3 fuerza su reproductor interno (Ace Player)
                intent = new Intent("org.acestream.action.start_content");
                intent.setData(Uri.parse("acestream:?content_id=" + id));
                if (app.equals("aceplayer")) intent.putExtra("org.acestream.EXTRA_SELECTED_PLAYER", "{\"type\": 3}");
                break;
            }
            case "aceserve": {
                intent = new Intent(Intent.ACTION_VIEW, Uri.parse("acestream://" + id));
                String pkg = firstInstalled(ACESERVE);
                if (pkg != null) intent.setPackage(pkg);
                else chooser = true;
                break;
            }
            case "vlc": {
                intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(Uri.parse(url), "video/*");
                intent.putExtra("title", call.getString("titulo", ""));
                String pkg = firstInstalled(VLC);
                if (pkg != null) intent.setPackage(pkg);
                else chooser = true;
                break;
            }
            case "web": {
                // Un enlace de página (p. ej. YouTube): lo abre la app que lo gestione (YouTube de la tele o el navegador)
                intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                break;
            }
            case "url": {
                intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(Uri.parse(url), "video/*");
                chooser = true;
                break;
            }
            default: {
                intent = new Intent(Intent.ACTION_VIEW, Uri.parse("acestream://" + id));
                chooser = true;
            }
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            Intent launch = chooser ? Intent.createChooser(intent, "Abrir con…") : intent;
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(launch);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            if (app.equals("aceplayer") || app.equals("acestream")) {
                // Versiones antiguas de Ace Stream: enlace acestream:// normal
                try {
                    Intent old = new Intent(Intent.ACTION_VIEW, Uri.parse("acestream://" + id));
                    old.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getActivity().startActivity(old);
                    call.resolve();
                    return;
                } catch (ActivityNotFoundException ignored) {
                    // sigue abajo
                }
            }
            call.reject("No hay ninguna app instalada que pueda abrirlo", "NO_APP");
        }
    }
}
