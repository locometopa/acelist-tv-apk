package es.locometopa.acelisttv;

import org.json.JSONObject;

import android.content.res.AssetManager;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Servidor HTTP mínimo para el panel del móvil.
 * - Sirve la página del móvil (assets/public/movil/...).
 * - Cada petición /api/... comprueba la clave y se pasa a la app (JavaScript), que la contesta.
 */
class ServidorMovil {

    interface Reenvio {
        void peticion(String id, String method, String path, String body);
    }

    /** Recibe una APK subida desde el panel y la instala. Devuelve null si ha ido bien, o el error. */
    interface Instalador {
        String instalar(InputStream datos, long largo);
    }

    private Instalador instalador;
    void setInstalador(Instalador i) { instalador = i; }

    private static final int MAX_BODY = 25 * 1024 * 1024;
    private static final long ESPERA_SEGUNDOS = 90;

    private static class Pendiente {
        final CountDownLatch hecho = new CountDownLatch(1);
        int status = 504;
        String body = "{\"error\":\"La tele no respondió. ¿Está AceList TV abierta?\"}";
    }

    private final AssetManager assets;
    private final Reenvio reenvio;
    private final Map<String, Pendiente> pendientes = new ConcurrentHashMap<>();
    private volatile ServerSocket socket;
    private volatile String token;
    private ExecutorService pool;
    private int puerto;

    ServidorMovil(AssetManager assets, Reenvio reenvio) {
        this.assets = assets;
        this.reenvio = reenvio;
    }

    synchronized int iniciar(int puertoPedido, String nuevoToken) throws IOException {
        token = nuevoToken;
        if (socket != null && !socket.isClosed() && puerto == puertoPedido) return puerto;
        detener();
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress(puertoPedido));
        socket = s;
        puerto = puertoPedido;
        pool = Executors.newFixedThreadPool(6);
        Thread aceptar = new Thread(() -> {
            while (!s.isClosed()) {
                try {
                    final Socket cliente = s.accept();
                    pool.execute(() -> atender(cliente));
                } catch (IOException e) {
                    // socket cerrado
                }
            }
        }, "AceListMovil");
        aceptar.setDaemon(true);
        aceptar.start();
        return puerto;
    }

    synchronized void detener() {
        if (socket != null) {
            try { socket.close(); } catch (IOException ignored) { }
            socket = null;
        }
        if (pool != null) {
            pool.shutdownNow();
            pool = null;
        }
        for (Pendiente p : pendientes.values()) p.hecho.countDown();
        pendientes.clear();
    }

    void responder(String id, int status, String body) {
        Pendiente p = pendientes.remove(id);
        if (p == null) return;
        p.status = status;
        p.body = body == null ? "{}" : body;
        p.hecho.countDown();
    }

    static String ipLocal() {
        String otra = null;
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a.isLoopbackAddress() || a.getAddress().length != 4) continue;
                    String ip = a.getHostAddress();
                    if (ip.startsWith("192.168.")) return ip;
                    if (otra == null && a.isSiteLocalAddress()) otra = ip;
                }
            }
        } catch (Exception ignored) { }
        return otra != null ? otra : "127.0.0.1";
    }

    // ---------- HTTP ----------

    private void atender(Socket cliente) {
        try (Socket c = cliente) {
            c.setSoTimeout(30000);
            InputStream in = c.getInputStream();
            OutputStream out = c.getOutputStream();
            String cabecera = leerCabecera(in);
            if (cabecera == null) return;
            String[] lineas = cabecera.split("\r\n");
            String[] primera = lineas[0].split(" ");
            if (primera.length < 2) { enviar(out, 400, "text/plain", "petición no válida"); return; }
            String method = primera[0].toUpperCase(Locale.ROOT);
            String target = primera[1];
            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lineas.length; i++) {
                int dp = lineas[i].indexOf(':');
                if (dp > 0) headers.put(lineas[i].substring(0, dp).trim().toLowerCase(Locale.ROOT), lineas[i].substring(dp + 1).trim());
            }
            String path = target;
            String query = "";
            int q = target.indexOf('?');
            if (q >= 0) { path = target.substring(0, q); query = target.substring(q + 1); }

            if (path.startsWith("/api/")) {
                String clave = headers.get("x-token");
                if (clave == null) clave = parametro(query, "t");
                if (!claveCorrecta(clave)) {
                    enviar(out, 401, "application/json", "{\"error\":\"Clave incorrecta: vuelve a escanear el código de la tele\"}");
                    return;
                }
                // Actualización de la app subida desde el panel: va directa a un archivo, sin pasar por la app web
                if (path.equals("/api/apk") && method.equals("POST")) {
                    long l = 0;
                    try { l = Long.parseLong(headers.getOrDefault("content-length", "0")); } catch (NumberFormatException ignored) { }
                    if (l <= 0 || l > 300L * 1024 * 1024) { enviar(out, 400, "application/json", "{\"error\":\"Archivo no válido\"}"); return; }
                    c.setSoTimeout(120000);
                    String err = instalador == null ? "No disponible" : instalador.instalar(in, l);
                    if (err == null) enviar(out, 200, "application/json", "{\"ok\":true}");
                    else enviar(out, 500, "application/json; charset=utf-8", new JSONObject().put("error", err).toString());
                    return;
                }
                int largo = 0;
                try { largo = Integer.parseInt(headers.getOrDefault("content-length", "0")); } catch (NumberFormatException ignored) { }
                if (largo > MAX_BODY) { enviar(out, 413, "application/json", "{\"error\":\"Demasiado grande\"}"); return; }
                String body = new String(leerExacto(in, largo), StandardCharsets.UTF_8);
                String id = UUID.randomUUID().toString();
                Pendiente p = new Pendiente();
                pendientes.put(id, p);
                reenvio.peticion(id, method, path, body);
                try { p.hecho.await(ESPERA_SEGUNDOS, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
                pendientes.remove(id);
                enviar(out, p.status, "application/json; charset=utf-8", p.body);
                return;
            }
            if (!method.equals("GET") && !method.equals("HEAD")) { enviar(out, 405, "text/plain", "método no permitido"); return; }
            servirArchivo(out, path);
        } catch (Exception ignored) {
            // conexión cortada
        }
    }

    private boolean claveCorrecta(String clave) {
        String t = token;
        if (t == null || clave == null) return false;
        return MessageDigest.isEqual(t.getBytes(StandardCharsets.UTF_8), clave.getBytes(StandardCharsets.UTF_8));
    }

    private void servirArchivo(OutputStream out, String path) throws IOException {
        // "/" o "/<clave>" (enlace corto) muestran la página del móvil
        String nombre = path.equals("/") || path.matches("/[A-Za-z0-9]{6,16}/?") ? "index.html" : path.substring(1);
        try { nombre = URLDecoder.decode(nombre, "UTF-8"); } catch (Exception ignored) { }
        if (nombre.contains("..") || nombre.startsWith("/")) { enviar(out, 403, "text/plain", "prohibido"); return; }
        byte[] datos;
        try (InputStream f = assets.open("public/movil/" + nombre)) {
            datos = leerTodo(f);
        } catch (IOException e) {
            enviar(out, 404, "text/plain", "no encontrado");
            return;
        }
        enviarBytes(out, 200, tipo(nombre), datos);
    }

    private static String tipo(String nombre) {
        String n = nombre.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".woff2")) return "font/woff2";
        if (n.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    private static String parametro(String query, String nombre) {
        for (String par : query.split("&")) {
            int eq = par.indexOf('=');
            if (eq > 0 && par.substring(0, eq).equals(nombre)) {
                try { return URLDecoder.decode(par.substring(eq + 1), "UTF-8"); } catch (Exception e) { return null; }
            }
        }
        return null;
    }

    private static String leerCabecera(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int a = 0, b = 0, c = 0;
        while (true) {
            int d = in.read();
            if (d < 0) return null;
            buf.write(d);
            if (buf.size() > 32 * 1024) return null;
            // fin de cabecera: \r\n\r\n
            if (a == '\r' && b == '\n' && c == '\r' && d == '\n') break;
            a = b; b = c; c = d;
        }
        return new String(buf.toByteArray(), StandardCharsets.ISO_8859_1).trim();
    }

    private static byte[] leerExacto(InputStream in, int largo) throws IOException {
        byte[] datos = new byte[largo];
        int leido = 0;
        while (leido < largo) {
            int n = in.read(datos, leido, largo - leido);
            if (n < 0) break;
            leido += n;
        }
        return datos;
    }

    private static byte[] leerTodo(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] trozo = new byte[16384];
        int n;
        while ((n = in.read(trozo)) > 0) buf.write(trozo, 0, n);
        return buf.toByteArray();
    }

    private static void enviar(OutputStream out, int status, String tipo, String texto) throws IOException {
        enviarBytes(out, status, tipo, texto.getBytes(StandardCharsets.UTF_8));
    }

    private static void enviarBytes(OutputStream out, int status, String tipo, byte[] datos) throws IOException {
        String cabecera = "HTTP/1.1 " + status + " " + razon(status) + "\r\n"
            + "Content-Type: " + tipo + "\r\n"
            + "Content-Length: " + datos.length + "\r\n"
            + "Cache-Control: no-store\r\n"
            + "Connection: close\r\n\r\n";
        out.write(cabecera.getBytes(StandardCharsets.ISO_8859_1));
        out.write(datos);
        out.flush();
    }

    private static String razon(int status) {
        switch (status) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 409: return "Conflict";
            case 413: return "Payload Too Large";
            case 503: return "Service Unavailable";
            case 504: return "Gateway Timeout";
            default: return "Error";
        }
    }
}
