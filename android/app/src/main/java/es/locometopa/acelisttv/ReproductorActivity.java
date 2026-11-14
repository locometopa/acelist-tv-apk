package es.locometopa.acelisttv;

import android.app.Activity;
import android.app.UiModeManager;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.C;
import androidx.media3.common.Tracks;
import androidx.media3.exoplayer.DecoderCounters;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory;
import androidx.media3.extractor.ts.TsExtractor;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Reproductor nativo (Media3 / ExoPlayer) para los canales.
 * Pide cada canal al motor de Ace Stream (getstream en JSON), reproduce su stream,
 * muestra peers y velocidad, y permite hacer zapping con ▲▼ o los botones de canal.
 */
public class ReproductorActivity extends Activity {

    public static final String EXTRA_IDS = "ids";
    public static final String EXTRA_TITULOS = "titulos";
    public static final String EXTRA_URLS = "urls";
    public static final String EXTRA_ENLACES = "enlaces";
    public static final String EXTRA_INDICE = "indice";
    public static final String EXTRA_MOTOR = "motor";
    public static final String EXTRA_FORMATO = "formato";
    public static final String EXTRA_BLOQUEO = "bloqueo";
    // Si la tele se bloquea desde el servidor mientras se ve un canal, se cierra el reproductor
    private String urlBloqueo = "";
    private final Runnable mirarBloqueo = new Runnable() {
        @Override public void run() {
            final String u = urlBloqueo;
            if (u != null && !u.isEmpty() && !red.isShutdown()) {
                red.execute(() -> {
                    try {
                        if (pedir(u, 5000).optBoolean("bloqueada", false)) ui.post(() -> finish());
                    } catch (Exception ignored) { /* sin servidor: se sigue viendo */ }
                });
            }
            ui.postDelayed(this, 10000);
        }
    };

    private ArrayList<String> ids;
    private ArrayList<String> titulos;
    private ArrayList<String> urls;
    private ArrayList<String> enlaces;
    // Enlaces del canal actual (el elegido y los demás del mismo canal); si uno falla se pasa al siguiente
    private final ArrayList<String[]> fuentes = new ArrayList<>();
    private int fuente = 0;
    private int indice;
    private String motor;
    // Cómo se pide el canal al motor: "ts" (flujo continuo, como siempre) o "hls" (troceado: aguanta mejor
    // los saltos de tiempo del stream que dejan la imagen congelada con sonido). Se cambia con la tecla ≡.
    private String formato = "ts";
    private String formatoElegido = "ts";   // el de Ajustes; «formato» puede cambiar solo para un canal
    // Canales (id del enlace) que no se pueden leer en TS: se abren directamente en HLS
    private java.util.Set<String> soloHls = new java.util.HashSet<>();

    private ExoPlayer player;
    private PlayerView vista;
    private LinearLayout panel;
    private TextView txtNumero, txtTitulo, txtEstado, txtAyuda, txtZap;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean esTele = true;
    private GestureDetector gestos;
    private final ExecutorService red = Executors.newSingleThreadExecutor();
    private volatile int generacion = 0;
    private volatile String statUrl = null;
    private volatile String commandUrl = null;
    private int reintentos = 0;
    // Vueltas completas a todos los enlaces del canal sin conseguir que suene
    private int vueltas = 0;
    private static final int MAX_VUELTAS = 2;
    // Lo que se aprende de cada enlace (si arrancó y con cuántos peers); la app lo recoge al volver
    private volatile int maxPeers = -1;
    private boolean apuntado = false;
    // Imagen congelada con sonido: se vigila si salen fotogramas nuevos mientras avanza el audio
    private int ultimoRender = -1;
    private int ultimoDescarte = -1;
    private int lentos = 0;
    private long ultimoOk = 0;
    private long ultimaPos = -1;
    private int congelado = 0;
    private int arreglosImagen = 0;
    private long primerArreglo = 0;
    private boolean avisoVideo = false;
    private final Runnable vigiaImagen = new Runnable() {
        @Override public void run() { revisarImagen(); ui.postDelayed(this, 2000); }
    };
    public static final String PREFS = "hometv_reproductor";

    private final Runnable ocultarPanel = () -> panel.animate().alpha(0f).setDuration(300);
    private final Runnable ocultarZap = () -> txtZap.setVisibility(View.GONE);
    private Runnable cargaPendiente = null;
    // Si no arranca o se queda cargando demasiado, se prueba el siguiente enlace
    private final Runnable vigilante = () -> {
        if (player == null || player.getPlaybackState() == Player.STATE_READY) return;
        // Si nunca llegó a sonar, mejor otro enlace; si se ha cortado a mitad, primero se intenta recuperar
        if (this.yaSonando) recuperar("Se ha quedado cargando"); else siguienteFuente("No arranca");
    };
    private boolean yaSonando = false;
    private final Runnable sondeo = new Runnable() {
        @Override public void run() { consultarEstado(); ui.postDelayed(this, 3000); }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        UiModeManager modo = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        esTele = modo != null && modo.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;

        ids = getIntent().getStringArrayListExtra(EXTRA_IDS);
        titulos = getIntent().getStringArrayListExtra(EXTRA_TITULOS);
        indice = getIntent().getIntExtra(EXTRA_INDICE, 0);
        motor = getIntent().getStringExtra(EXTRA_MOTOR);
        String f = getIntent().getStringExtra(EXTRA_FORMATO);
        if ("hls".equals(f)) formato = "hls";
        formatoElegido = formato;
        urlBloqueo = getIntent().getStringExtra(EXTRA_BLOQUEO);
        soloHls = new java.util.HashSet<>(getSharedPreferences(PREFS, MODE_PRIVATE).getStringSet("soloHls", new java.util.HashSet<>()));
        if (ids == null || ids.isEmpty()) { finish(); return; }
        if (titulos == null) titulos = new ArrayList<>(ids);
        urls = getIntent().getStringArrayListExtra(EXTRA_URLS);
        if (urls == null) urls = new ArrayList<>();
        while (urls.size() < ids.size()) urls.add("");
        enlaces = getIntent().getStringArrayListExtra(EXTRA_ENLACES);
        if (enlaces == null) enlaces = new ArrayList<>();
        while (enlaces.size() < ids.size()) enlaces.add("");
        if (motor == null || motor.isEmpty()) motor = "http://127.0.0.1:6878";
        motor = motor.replaceAll("/+$", "");

        construirVista();

        // Base del reproductor igual que en la 0.22 (la que iba bien): búfer amplio, lectura del MPEG-TS
        // por defecto y decodificadores de la tele. Los ajustes de la 0.23-0.27 (búfer en segundos, otras
        // opciones del lector de TS, reintentos propios, Media3 1.9 + FFmpeg) daban imagen congelada con sonido.
        DefaultLoadControl carga = new DefaultLoadControl.Builder()
            .setBufferDurationsMs(15000, 60000, 2500, 5000)
            .build();
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
            .setConnectTimeoutMs(30000)
            .setReadTimeoutMs(30000)
            .setAllowCrossProtocolRedirects(true)
            .setUserAgent("AceListTV");
        player = new ExoPlayer.Builder(this)
            .setLoadControl(carga)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(http))
            .build();
        vista.setPlayer(player);
        player.addListener(new Player.Listener() {
            @Override public void onPlaybackStateChanged(int estado) {
                if (estado == Player.STATE_BUFFERING) {
                    txtEstado.setText("Cargando…");
                    if (yaSonando) { ui.removeCallbacks(vigilante); ui.postDelayed(vigilante, 25000); }
                }
                if (estado == Player.STATE_READY) {
                    reintentos = 0; vueltas = 0; yaSonando = true; ui.removeCallbacks(vigilante); mostrarPanel(4000);
                    if (!apuntado) { apuntado = true; apuntar(true, null); }
                }
            }
            @Override public void onTracksChanged(Tracks tracks) {
                // Vídeo que la tele no sabe decodificar (MPEG-2, HEVC 10 bits…): se oye pero la imagen no sale
                for (Tracks.Group g : tracks.getGroups()) {
                    if (g.getType() != C.TRACK_TYPE_VIDEO) continue;
                    boolean alguno = false;
                    String mime = null;
                    for (int i = 0; i < g.length; i++) {
                        if (g.isTrackSupported(i, true)) alguno = true;
                        if (mime == null) mime = g.getTrackFormat(i).sampleMimeType;
                    }
                    if (!alguno) videoNoCompatible(mime);
                }
            }
            @Override public void onPlayerError(PlaybackException error) {
                // Emisión HLS que se ha quedado atrás: volver al directo sin más
                if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                    player.seekToDefaultPosition();
                    player.prepare();
                    return;
                }
                // El reproductor no reconoce lo que manda el motor en TS (VLC sí): ese canal se pasa a HLS,
                // que el motor manda ya troceado, y se recuerda para la próxima vez
                boolean noLeeTs = error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED
                    || error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED;
                if (noLeeTs && !"hls".equals(formato) && player.getCurrentMediaItem() != null && !fuentes.isEmpty()
                        && (fuentes.get(fuente)[1] == null || fuentes.get(fuente)[1].isEmpty())) {
                    formato = "hls";
                    String id = fuentes.get(fuente)[0];
                    soloHls.add(id);
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putStringSet("soloHls", new java.util.HashSet<>(soloHls)).apply();
                    reintentos = 0;
                    cargar(false);
                    txtEstado.setText("Este canal no se lee en TS: pasando a HLS…");
                    return;
                }
                recuperar("Error " + error.getErrorCodeName());
            }
        });
        cargar(true);
        ui.postDelayed(mirarBloqueo, 10000);
        // La vigilancia automática de la imagen (vigiaImagen) queda desactivada: recolocaba de más.
        // Se puede recolocar a mano con OK dos veces (mando) o manteniendo pulsado (móvil).
    }

    private void revisarImagen() {
        if (player == null || player.getPlaybackState() != Player.STATE_READY || !player.getPlayWhenReady()
            || !player.getCurrentTracks().isTypeSelected(C.TRACK_TYPE_VIDEO)) {
            congelado = 0; ultimoRender = -1; ultimaPos = -1;
            return;
        }
        DecoderCounters dc = player.getVideoDecoderCounters();
        if (dc == null) return;
        dc.ensureUpdated();
        int r = dc.renderedOutputBufferCount;
        int d = dc.droppedBufferCount + dc.skippedOutputBufferCount;
        long pos = player.getCurrentPosition();
        boolean avanza = ultimaPos >= 0 && pos - ultimaPos > 1000;
        if (ultimoRender >= 0 && r == ultimoRender && avanza) congelado++; else congelado = 0;
        // La tele no puede con el vídeo (tira más fotogramas de los que enseña durante ~20 s)
        if (ultimoRender >= 0 && ultimoDescarte >= 0) {
            int vistos = r - ultimoRender, tirados = d - ultimoDescarte;
            if (tirados > 10 && tirados > vistos) lentos++; else if (vistos > 0) lentos = Math.max(0, lentos - 1);
        }
        ultimoRender = r;
        ultimoDescarte = d;
        ultimaPos = pos;
        // Unos 4 segundos con el sonido avanzando y sin ningún fotograma nuevo
        if (congelado >= 2) { congelado = 0; arreglarImagen(); }
        else if (lentos >= 10) {
            lentos = 0;
            if (fuentes.size() > 1) { apuntado = false; siguienteFuente("La tele no puede con el vídeo de este enlace"); }
            else { txtEstado.setText("La tele va justa con el vídeo de este canal: puede verse a saltos."); mostrarPanel(5000); }
        }
    }

    private void arreglarImagen() {
        long ahora = System.currentTimeMillis();
        if (ahora - primerArreglo > 90000) { primerArreglo = ahora; arreglosImagen = 0; }
        arreglosImagen++;
        if (arreglosImagen <= 2) {
            // Volver a conectar con la misma sesión del motor: el vídeo arranca de nuevo en el siguiente fotograma clave
            txtEstado.setText("La imagen se había quedado congelada · recolocando…");
            mostrarPanel(3000);
            ultimoRender = -1; ultimaPos = -1; ultimoDescarte = -1;
            player.stop();
            player.prepare();
            player.setPlayWhenReady(true);
        } else if (fuentes.size() > 1) {
            apuntado = false;
            siguienteFuente("La imagen se congela a menudo");
        } else {
            arreglosImagen = 0;
            txtEstado.setText("La imagen de este canal se congela a menudo. Prueba otro canal o Ace Player.");
            mostrarPanel(6000);
        }
    }

    // Recolocar a mano (OK dos veces en el mando, o mantener pulsado en el móvil): reconecta con la misma sesión
    private void recolocar() {
        if (player == null || player.getCurrentMediaItem() == null) return;
        txtEstado.setText("Recolocando la imagen…");
        mostrarPanel(2500);
        ultimoRender = -1; ultimaPos = -1; ultimoDescarte = -1; congelado = 0;
        player.stop();
        player.prepare();
        player.setPlayWhenReady(true);
    }

    private void videoNoCompatible(String mime) {
        if (avisoVideo) return;
        avisoVideo = true;
        String formato = mime == null ? "desconocido" : mime.replace("video/", "").replace("mpeg2", "MPEG-2").replace("hevc", "HEVC").toUpperCase(java.util.Locale.ROOT);
        if (fuentes.size() > 1) {
            apuntado = false;
            siguienteFuente("La tele no puede mostrar el vídeo de este enlace (" + formato + ")");
        } else {
            txtEstado.setText("Se oye, pero esta tele no puede mostrar el vídeo de este canal (" + formato + "). Prueba con Ace Player o VLC.");
            mostrarPanel(0);
        }
    }

    private TextView texto(float sp, int color, boolean negrita) {
        TextView t = new TextView(this);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (negrita) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private void construirVista() {
        FrameLayout raiz = new FrameLayout(this);
        raiz.setBackgroundColor(Color.BLACK);

        vista = new PlayerView(this);
        vista.setUseController(false);
        vista.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        vista.setKeepContentOnPlayerReset(false);
        raiz.addView(vista, new FrameLayout.LayoutParams(-1, -1));

        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(64, 40, 64, 48);
        GradientDrawable fondo = new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
            new int[] { 0xE6000000, 0x00000000 });
        panel.setBackground(fondo);
        txtNumero = texto(16, 0xFFFF7A1A, true);
        txtTitulo = texto(30, Color.WHITE, true);
        txtEstado = texto(18, 0xFFC9D1DB, false);
        txtAyuda = texto(14, 0xFF8E9AAB, false);
        txtAyuda.setText(esTele
            ? "▲▼ canal · ◀▶ enlace · OK información · ≡ formato TS/HLS · Atrás salir"
            : "Desliza ↑↓ canal · ←→ enlace · Toca: información · Doble toque: pausa · Mantén pulsado: arreglar imagen congelada");
        panel.addView(txtNumero);
        panel.addView(txtTitulo);
        panel.addView(txtEstado);
        panel.addView(txtAyuda);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        raiz.addView(panel, lp);

        txtZap = texto(26, Color.WHITE, true);
        txtZap.setPadding(36, 20, 36, 20);
        GradientDrawable zf = new GradientDrawable();
        zf.setColor(0xC8000000);
        zf.setCornerRadius(24);
        txtZap.setBackground(zf);
        txtZap.setVisibility(View.GONE);
        FrameLayout.LayoutParams zl = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.END);
        zl.setMargins(0, 48, 64, 0);
        raiz.addView(txtZap, zl);

        setContentView(raiz);
        if (!esTele) prepararTactil();
    }

    // Móvil: pantalla completa de verdad (sin barras) y gestos con el dedo en lugar del mando
    private void prepararTactil() {
        panel.setPadding(48, 28, 48, 36);
        WindowInsetsControllerCompat barras = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        barras.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        barras.hide(WindowInsetsCompat.Type.systemBars());
        gestos = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onDown(MotionEvent e) { return true; }
            @Override public boolean onSingleTapConfirmed(MotionEvent e) {
                if (panel.getAlpha() > 0.5f) panel.animate().alpha(0f).setDuration(200); else mostrarPanel(5000);
                return true;
            }
            @Override public boolean onDoubleTap(MotionEvent e) {
                if (player == null) return true;
                if (player.isPlaying()) player.pause(); else player.play();
                mostrarPanel(3000);
                return true;
            }
            @Override public void onLongPress(MotionEvent e) { recolocar(); }
            @Override public boolean onFling(MotionEvent a, MotionEvent b, float vx, float vy) {
                if (a == null) return false;
                float dx = b.getX() - a.getX();
                float dy = b.getY() - a.getY();
                float minimo = 80 * getResources().getDisplayMetrics().density;
                if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > minimo) { zap(dy < 0 ? 1 : -1); return true; }
                if (Math.abs(dx) > minimo) { cambiarFuente(dx < 0 ? 1 : -1); return true; }
                return false;
            }
        });
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (gestos != null && gestos.onTouchEvent(ev)) return true;
        return super.dispatchTouchEvent(ev);
    }

    // Línea técnica (en lugar de la ayuda, cuando el canal ya se ve): para saber de qué tipo es un corte
    private String datosTecnicos() {
        StringBuilder sb = new StringBuilder("hls".equals(formato) ? "HLS" : "TS");
        androidx.media3.common.Format v = player.getVideoFormat();
        if (v != null) {
            if (v.height > 0) sb.append(" · ").append(v.height).append("p");
            String m = v.sampleMimeType == null ? "" : v.sampleMimeType.replace("video/", "");
            if (m.equals("avc")) m = "H.264"; else if (m.equals("hevc")) m = "HEVC"; else if (m.equals("mpeg2")) m = "MPEG-2";
            if (!m.isEmpty()) sb.append(" · ").append(m);
            if (v.frameRate > 0) sb.append(" · ").append(Math.round(v.frameRate)).append(" fps");
        }
        androidx.media3.common.Format a = player.getAudioFormat();
        if (a != null && a.sampleMimeType != null) sb.append(" · audio ").append(a.sampleMimeType.replace("audio/", "").replace("mp4a-latm", "AAC").replace("mpeg", "MP2").toUpperCase(java.util.Locale.ROOT));
        DecoderCounters dc = player.getVideoDecoderCounters();
        if (dc != null) { dc.ensureUpdated(); if (dc.droppedBufferCount > 0) sb.append(" · ").append(dc.droppedBufferCount).append(" fotogramas perdidos"); }
        sb.append("   ·   ").append(esTele ? "≡ TS/HLS · OK×2 recolocar" : "Mantén pulsado: recolocar");
        return sb.toString();
    }

    private void mostrarPanel(long ms) {
        panel.animate().cancel();
        panel.setAlpha(1f);
        ui.removeCallbacks(ocultarPanel);
        if (ms > 0) ui.postDelayed(ocultarPanel, ms);
    }

    private void rotular() {
        String num = ids.size() > 1 ? (indice + 1) + " / " + ids.size() : "";
        if (fuentes.size() > 1) num += (num.isEmpty() ? "" : "   ·   ") + "Enlace " + (fuente + 1) + " de " + fuentes.size();
        if ("hls".equals(formato)) num += (num.isEmpty() ? "" : "   ·   ") + "HLS";
        txtNumero.setText(num);
        txtTitulo.setText(titulos.get(indice));
    }

    private void prepararFuentes() {
        fuentes.clear();
        fuente = 0;
        try {
            String j = enlaces.get(indice);
            if (j != null && !j.isEmpty()) {
                JSONArray a = new JSONArray(j);
                for (int i = 0; i < a.length(); i++) {
                    JSONObject o = a.getJSONObject(i);
                    fuentes.add(new String[] { o.optString("id", ""), o.optString("url", "") });
                }
            }
        } catch (Exception ignored) { fuentes.clear(); }
        if (fuentes.isEmpty()) fuentes.add(new String[] { ids.get(indice), urls.get(indice) });
    }

    /**
     * Algo ha fallado o se ha quedado cargando. De menos a más:
     * 1) volver a conectar con la misma sesión del motor (lo más rápido, el motor sigue descargando),
     * 2) pedir el canal de nuevo al motor,
     * 3) pasar al siguiente enlace del canal.
     */
    private void recuperar(String motivo) {
        ui.removeCallbacks(vigilante);
        final int g = generacion;
        mostrarPanel(0);
        if (reintentos == 0 && player.getCurrentMediaItem() != null) {
            reintentos++;
            txtEstado.setText(motivo + " · reconectando…");
            ui.postDelayed(() -> {
                if (g != generacion) return;
                player.prepare();
                player.setPlayWhenReady(true);
                ui.postDelayed(vigilante, 25000);
            }, 1500);
        } else if (reintentos <= 1) {
            reintentos = 2;
            txtEstado.setText(motivo + " · volviendo a pedir el canal…");
            ui.postDelayed(() -> { if (g == generacion) cargar(false); }, 2000);
        } else {
            siguienteFuente(motivo);
        }
    }

    // El enlace actual no va: el siguiente del mismo canal; al acabarlos, otra vuelta tras una pausa
    private void siguienteFuente(String motivo) {
        ui.removeCallbacks(vigilante);
        final int g = generacion;
        if (!apuntado) { apuntado = true; apuntar(false, motivo); }
        if (fuente + 1 < fuentes.size()) {
            fuente++;
            reintentos = 0;
            cargar(false);
            txtEstado.setText(motivo + " · probando el enlace " + (fuente + 1) + " de " + fuentes.size() + "…");
        } else if (vueltas + 1 < MAX_VUELTAS) {
            vueltas++;
            txtEstado.setText(motivo + " · se vuelve a intentar en unos segundos…");
            mostrarPanel(0);
            ui.postDelayed(() -> {
                if (g != generacion) return;
                fuente = 0;
                reintentos = 0;
                cargar(false);
            }, 8000);
        } else {
            txtEstado.setText(motivo + (fuentes.size() > 1 ? ". Probados los " + fuentes.size() + " enlaces" : "")
                + ". Prueba otro canal (" + (esTele ? "▲▼" : "desliza") + ") o Ace Player.");
            mostrarPanel(0);
        }
    }

    // Cortes cortos de la conexión con el motor: se reintenta en el sitio (sin que se note) antes de dar error
    private static class Reintentos extends DefaultLoadErrorHandlingPolicy {
        @Override public long getRetryDelayMsFor(LoadErrorHandlingPolicy.LoadErrorInfo info) {
            Throwable e = info.exception;
            if (e instanceof HttpDataSource.InvalidResponseCodeException) {
                int codigo = ((HttpDataSource.InvalidResponseCodeException) e).responseCode;
                // La sesión ya no existe en el motor: no tiene sentido insistir con la misma dirección
                if (codigo == 404 || codigo == 410 || codigo == 403) return C.TIME_UNSET;
            }
            return Math.min(1000L * info.errorCount, 3000L);
        }
        @Override public int getMinimumLoadableRetryCount(int tipo) { return 6; }
    }

    private void cambiarFuente(int paso) {
        if (fuentes.size() < 2) { mostrarPanel(5000); return; }
        fuente = (fuente + paso + fuentes.size()) % fuentes.size();
        reintentos = 0;
        vueltas = 0;
        cargar(false);
    }

    // Pide el canal al motor y lo reproduce
    private void cargar(boolean nuevo) {
        final int g = ++generacion;
        if (nuevo) { reintentos = 0; vueltas = 0; prepararFuentes(); }
        // Cada enlace en su formato: el elegido en Ajustes, salvo los que ya se sabe que solo van en HLS
        if (!fuentes.isEmpty()) {
            String idF = fuentes.get(fuente)[0];
            if (soloHls.contains(idF)) formato = "hls";
            else formato = formatoElegido;
        }
        yaSonando = false;
        apuntado = false;
        avisoVideo = false;
        ultimoRender = -1; ultimaPos = -1; congelado = 0; ultimoDescarte = -1; lentos = 0;
        maxPeers = -1;
        ui.removeCallbacks(vigilante);
        rotular();
        txtEstado.setText("Pidiendo el canal al motor…");
        mostrarPanel(0);
        ui.removeCallbacks(sondeo);
        final String anteriorCmd = commandUrl;
        statUrl = null;
        commandUrl = null;
        player.stop();
        player.clearMediaItems();
        final String id = fuentes.get(fuente)[0];
        final String directa = fuentes.get(fuente)[1];
        if (directa != null && !directa.isEmpty()) {
            // Canal de TV normal (HLS): sin motor de Ace Stream
            if (anteriorCmd != null) red.execute(() -> parar(anteriorCmd));
            player.setMediaItem(MediaItem.fromUri(Uri.parse(directa)));
            player.prepare();
            player.setPlayWhenReady(true);
            txtEstado.setText("Emisión en abierto");
            ui.postDelayed(vigilante, 30000);
            return;
        }
        red.execute(() -> {
            if (anteriorCmd != null) parar(anteriorCmd);
            String[] sesion = null;
            String error = null;
            for (String param : new String[] { "id", "infohash" }) {
                try {
                    String ruta = "hls".equals(formato) ? "/ace/manifest.m3u8" : "/ace/getstream";
                    JSONObject r = pedir(motor + ruta + "?format=json&" + param + "=" + id
                        + "&pid=" + URLEncoder.encode(UUID.randomUUID().toString(), "UTF-8"), param.equals("id") ? 20000 : 40000);
                    if (r.isNull("error") || r.optString("error").isEmpty()) {
                        JSONObject resp = r.getJSONObject("response");
                        sesion = new String[] {
                            rebase(resp.getString("playback_url")),
                            rebase(resp.getString("stat_url")),
                            rebase(resp.getString("command_url")) };
                        break;
                    }
                    error = r.optString("error");
                    if (!"failed to load content".equals(error)) break;
                } catch (Exception e) {
                    error = "El motor de Ace Stream no responde. ¿Está abierto?";
                    break;
                }
            }
            final String[] s = sesion;
            final String err = "failed to load content".equals(error) ? "El canal no existe o ha caducado" : error;
            ui.post(() -> {
                if (g != generacion) { if (s != null) red.execute(() -> parar(s[2])); return; }
                if (s == null) {
                    // Sin motor no tiene sentido probar otro enlace de Ace Stream
                    if (err != null && err.startsWith("El motor")) { txtEstado.setText(err); mostrarPanel(0); }
                    else siguienteFuente(err != null ? err : "No se pudo abrir el enlace");
                    return;
                }
                statUrl = s[1];
                commandUrl = s[2];
                MediaItem.Builder mi = new MediaItem.Builder().setUri(Uri.parse(s[0]));
                if ("hls".equals(formato)) {
                    mi.setMimeType(androidx.media3.common.MimeTypes.APPLICATION_M3U8);
                    // Unos segundos de colchón respecto al directo: los parones cortos del P2P no llegan a la imagen
                    mi.setLiveConfiguration(new MediaItem.LiveConfiguration.Builder().setTargetOffsetMs(12000).build());
                }
                player.setMediaItem(mi.build());
                player.prepare();
                player.setPlayWhenReady(true);
                txtEstado.setText("Conectando con los peers…");
                ui.postDelayed(sondeo, 2000);
                ui.postDelayed(vigilante, 45000);
            });
        });
    }

    // Apunta el resultado del enlace actual (máx. 200 resultados pendientes de recoger por la app)
    private void apuntar(boolean ok, String motivo) {
        try {
            String[] f = fuentes.get(fuente);
            JSONObject o = new JSONObject();
            o.put("id", f[0]);
            o.put("url", f[1] == null ? "" : f[1]);
            o.put("ok", ok);
            o.put("peers", maxPeers);
            o.put("motivo", motivo == null ? "" : motivo);
            o.put("at", System.currentTimeMillis());
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            JSONArray a = new JSONArray(sp.getString("resultados", "[]"));
            a.put(o);
            while (a.length() > 200) a.remove(0);
            sp.edit().putString("resultados", a.toString()).apply();
        } catch (Exception ignored) { }
    }

    // Las URL del motor vienen con 127.0.0.1:6878; se apuntan a la dirección configurada
    private String rebase(String url) {
        try {
            URL u = new URL(url);
            return motor + u.getPath() + (u.getQuery() != null ? "?" + u.getQuery() : "");
        } catch (Exception e) {
            return url;
        }
    }

    private void consultarEstado() {
        final String url = statUrl;
        final int g = generacion;
        if (url == null) return;
        red.execute(() -> {
            try {
                JSONObject r = pedir(url, 5000);
                JSONObject resp = r.optJSONObject("response");
                if (resp == null) return;
                String st = resp.optString("status", "");
                int peers = resp.optInt("peers", -1);
                if (peers > maxPeers) maxPeers = peers;
                int vel = resp.optInt("speed_down", -1);
                StringBuilder sb = new StringBuilder();
                sb.append(st.equals("dl") ? "Reproduciendo" : st.equals("prebuf") ? "Cargando" : "Conectando");
                if (peers >= 0) sb.append(" · ").append(peers).append(peers == 1 ? " peer" : " peers");
                if (vel >= 0) sb.append(" · ").append(vel >= 1024 ? String.format(java.util.Locale.ROOT, "%.1f MB/s", vel / 1024f) : vel + " KB/s");
                final String txt = sb.toString();
                ui.post(() -> {
                    if (g != generacion || player == null || player.getPlayerError() != null) return;
                    long bufer = player.getTotalBufferedDuration() / 1000;
                    txtEstado.setText(bufer > 0 ? txt + " · búfer " + bufer + " s" : txt);
                    if (yaSonando) txtAyuda.setText(datosTecnicos());
                });
            } catch (Exception ignored) {
                // se reintenta en el siguiente ciclo
            }
        });
    }

    private static JSONObject pedir(String url, int timeout) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(timeout);
        c.setReadTimeout(timeout);
        try (BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String linea;
            while ((linea = in.readLine()) != null) sb.append(linea);
            return new JSONObject(sb.toString());
        } finally {
            c.disconnect();
        }
    }

    private static void parar(String commandUrl) {
        try { pedir(commandUrl + (commandUrl.contains("?") ? "&" : "?") + "method=stop", 5000); } catch (Exception ignored) { }
    }

    // Zapping: se espera un instante por si se pulsan varias teclas seguidas
    private void zap(int paso) {
        if (ids.size() < 2) return;
        indice = (indice + paso + ids.size()) % ids.size();
        prepararFuentes();
        rotular();
        txtZap.setText((indice + 1) + "   " + titulos.get(indice));
        txtZap.setVisibility(View.VISIBLE);
        ui.removeCallbacks(ocultarZap);
        ui.postDelayed(ocultarZap, 1500);
        mostrarPanel(0);
        if (cargaPendiente != null) ui.removeCallbacks(cargaPendiente);
        cargaPendiente = () -> cargar(true);
        ui.postDelayed(cargaPendiente, 700);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_DPAD_UP:
            case KeyEvent.KEYCODE_CHANNEL_UP:
            case KeyEvent.KEYCODE_PAGE_UP:
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                zap(-1);
                return true;
            case KeyEvent.KEYCODE_DPAD_DOWN:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
            case KeyEvent.KEYCODE_PAGE_DOWN:
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                zap(1);
                return true;
            case KeyEvent.KEYCODE_DPAD_LEFT:
                cambiarFuente(-1);
                return true;
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                cambiarFuente(1);
                return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER: {
                long t = System.currentTimeMillis();
                if (t - ultimoOk < 600) { ultimoOk = 0; recolocar(); } else { ultimoOk = t; mostrarPanel(5000); }
                return true;
            }
            case KeyEvent.KEYCODE_MENU:
            case KeyEvent.KEYCODE_SETTINGS: {
                // Cambiar entre flujo continuo (TS) y troceado (HLS) para comparar
                formato = "hls".equals(formato) ? "ts" : "hls";
                formatoElegido = formato;
                if (!fuentes.isEmpty() && "ts".equals(formato) && soloHls.remove(fuentes.get(fuente)[0]))
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putStringSet("soloHls", new java.util.HashSet<>(soloHls)).apply();
                reintentos = 0;
                cargar(false);
                txtEstado.setText("Probando en formato " + ("hls".equals(formato) ? "HLS (troceado)" : "TS (continuo)") + "…");
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("formato", formato).apply();
                return true;
            }
            case KeyEvent.KEYCODE_INFO:
                mostrarPanel(5000);
                return true;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_SPACE:
                if (player.isPlaying()) player.pause(); else player.play();
                mostrarPanel(3000);
                return true;
            default:
                return super.onKeyDown(keyCode, event);
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        // Al salir (Atrás o botón de inicio) se cierra el canal y se libera el motor
        if (!isChangingConfigurations()) finish();
    }

    @Override
    protected void onDestroy() {
        generacion++;
        ui.removeCallbacksAndMessages(null);
        final String cmd = commandUrl;
        if (cmd != null) red.execute(() -> parar(cmd));
        red.shutdown();
        if (player != null) { player.release(); player = null; }
        super.onDestroy();
    }
}
