// HomeTV para Windows: canales del servidor de casa y reproductor con el motor de VLC.
// Sencillo a propósito: buscar, elegir, ver. El servidor ya entrega los canales agrupados (cada canal con sus
// enlaces, del mejor al peor), qué echan ahora y la agenda de partidos: aquí solo se enseña y se reproduce.
using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using LibVLCSharp.Shared;
using LibVLCSharp.WinForms;

namespace HomeTV;

static class Programa
{
    [STAThread]
    static void Main()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try { Core.Initialize(); }
        catch (Exception e)
        {
            MessageBox.Show("No se ha podido cargar el reproductor (falta la carpeta «libvlc» junto a HomeTV.exe).\n\n" + e.Message,
                "HomeTV", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        Application.Run(new Ventana());
    }
}

sealed class Enlace
{
    public string Id = "";
    public string Titulo = "";
    public string Tipo = "";     // "infohash" o vacío (content id)
    public string? Url;          // canal de TV normal (HLS); si es null, es de Ace Stream
    public string Estado = "";   // alive, no_peers, not_found… (última comprobación del servidor)
    public int Peers;
}

// Un canal con todos sus enlaces (el servidor los junta y los ordena del mejor al peor)
sealed class Canal
{
    public string Clave = "";
    public string Titulo = "";
    public string Categoria = "";
    public bool Favorito, Apagada;   // Apagada: viene de una lista apagada (solo sale al buscar)
    public bool Raro => Titulo.Length > 0 && !char.IsLetterOrDigit(Titulo.TrimStart().FirstOrDefault());   // empieza por un símbolo: va al final
    public string? Ahora;        // qué echan ahora (partido de la agenda o programa de la guía)
    public string? Luego;        // «21:00 Real Madrid - Getafe»
    public List<Enlace> Enlaces = new();
    public bool EsTv => Enlaces.Count > 0 && Enlaces[0].Url != null;
    public bool Vivo => Enlaces.Any(e => e.Estado == "alive" || e.Url != null);
    public int Peers => Enlaces.Count == 0 ? 0 : Enlaces.Max(e => e.Peers);
    public string Estado => Vivo ? "alive" : Enlaces.Any(e => e.Estado == "no_peers") ? "no_peers" : Enlaces.All(e => e.Estado.Length == 0) ? "" : "mal";
    public override string ToString() => Titulo;
}

sealed class Evento
{
    public string Id = "";
    public DateTime Inicio;
    public string Titulo = "";
    public string Competicion = "";
    public string Deporte = "";
    public string Canales = "";  // dónde lo dan, según la agenda
    public List<string> Claves = new();   // canales míos que lo emiten
    public List<(string Id, string Etiqueta)> Ace = new();   // enlaces acestream que trae la propia agenda (Ciriaco)
    public List<string> Enlaces = new();   // páginas (YouTube…) donde también se emite
    public bool Vivo, Aplazado, Posible, Favorito;
    public override string ToString() => Titulo;
}

sealed class Ajustes
{
    public string Servidor { get; set; } = "192.168.1.180";   // en casa
    public string ServidorExterno { get; set; } = "";          // fuera de casa (IP de Tailscale, la que empieza por 100.)
    public int Volumen { get; set; } = 100;
    public bool SoloVivos { get; set; } = true;
    public bool SoloConCanal { get; set; } = true;
    public bool ListaOculta { get; set; }   // la lista de canales de la izquierda escondida, para dar más sitio al vídeo
    public string UltimoCanal { get; set; } = "";
    public string MotorLocal { get; set; } = "auto";   // auto: el del PC solo si falla el del servidor · servidor · pc
    public int Colchon { get; set; } = 6000;   // milisegundos de vídeo que se guardan antes de enseñarlo (más = menos cortes, más retraso)

    static string Carpeta => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HomeTV");
    static string Archivo => Path.Combine(Carpeta, "ajustes.json");
    public static string ArchivoCanales => Path.Combine(Carpeta, "canales.json");

    public static Ajustes Cargar()
    {
        try { return JsonSerializer.Deserialize<Ajustes>(File.ReadAllText(Archivo)) ?? new Ajustes(); }
        catch { return new Ajustes(); }
    }
    public void Guardar()
    {
        try { Directory.CreateDirectory(Carpeta); File.WriteAllText(Archivo, JsonSerializer.Serialize(this)); }
        catch { /* sin disco: se pierde el ajuste, nada grave */ }
    }
}

sealed class Ventana : Form
{
    static readonly Color Fondo = Tema.Fondo;
    static readonly Color Principal = Tema.Principal;
    static readonly Color Panel1 = Tema.Panel1;
    static readonly Color Panel2 = Tema.Panel2;
    static readonly Color Texto = Tema.Texto;
    static readonly Color Tenue = Tema.Tenue;
    static readonly Color Acento = Tema.Acento;
    static readonly Color Directo = Tema.Directo;
    const string URL_VERSION = "https://github.com/locometopa/acelist-tv-apk/releases/download/windows/version.txt";
    const string URL_ACTUALIZACION = "https://github.com/locometopa/acelist-tv-apk/releases/download/windows/HomeTV-actualizacion.zip";

    readonly Ajustes ajustes = Ajustes.Cargar();
    readonly HttpClient http = new(new HttpClientHandler { AutomaticDecompression = DecompressionMethods.All }) { Timeout = TimeSpan.FromSeconds(15) };
    // Para lo que el servidor tarda en hacer (leer una lista grande o una cuenta IPTV): el cliente normal corta a los 15 s
    Font? pequenaFuente;
    readonly HttpClient httpLargo = new(new HttpClientHandler { AutomaticDecompression = DecompressionMethods.All }) { Timeout = TimeSpan.FromSeconds(150) };
    readonly string pid = Guid.NewGuid().ToString("N")[..12];

    readonly LibVLC vlc;
    readonly MediaPlayer reproductor;
    readonly VideoView video = new() { Dock = DockStyle.Fill, BackColor = Color.Black };

    // Cabecera (logo, buscador, estado) y menú lateral
    readonly Panel cabecera = new() { Dock = DockStyle.Top, Height = 50, BackColor = Fondo };
    readonly Panel cajaBuscar = new() { Height = 34, Width = 440, BackColor = Fondo };
    readonly TextBox buscar = new() { BorderStyle = BorderStyle.None, PlaceholderText = "Buscar equipo, partido o canal  (Ctrl+B)", BackColor = Panel1, ForeColor = Texto };
    readonly Panel riel = new() { Dock = DockStyle.Left, Width = 56, BackColor = Fondo };
    readonly BotonRiel rHoy = new("\uE80F", "Hoy");
    readonly BotonRiel rCanales = new("\uE7F4", "Canales");
    readonly BotonRiel rFavoritos = new("\uE734", "Favoritos");
    readonly BotonRiel rLista = new("\uE8FD", "Lista");   // esconde o enseña la lista de canales
    readonly BotonRiel rVpn = new("\uEA18", "VPN");
    readonly BotonRiel rAjustes = new("\uE713", "Ajustes");

    readonly Panel cuerpo = new() { Dock = DockStyle.Fill, BackColor = Principal };
    readonly Panel inicio = new() { Dock = DockStyle.Fill, BackColor = Principal, AutoScroll = true, Visible = false };
    readonly Panel ficha = new() { Dock = DockStyle.Right, Width = 290, BackColor = Principal, Visible = false };
    readonly Button fichaVer = new(), fichaFav = new(), fichaTele = new(), fichaGrabar = new();
    readonly Panel lateral = new() { Dock = DockStyle.Left, Width = 380, BackColor = Principal, Padding = new Padding(10) };
    readonly TableLayoutPanel pestanas = new() { Dock = DockStyle.Top, Height = 38, ColumnCount = 2, RowCount = 1 };
    readonly Button pestCanales, pestAgenda;
    readonly Button bLista, bAmpliar, bAudio;
    bool ampliado;        // el vídeo ocupa toda la ventana (sin lista ni ficha)
    bool viaAac;          // el sonido de este canal pasa por el servidor (convertido a AAC) porque aquí no se oía
    int pistasProbadas;
    DateTime revisarAudioEn = DateTime.MaxValue;
    readonly ComboBox categorias = new() { Dock = DockStyle.Top, DropDownStyle = ComboBoxStyle.DropDownList, FlatStyle = FlatStyle.Standard };
    readonly CheckBox filtro = new() { Dock = DockStyle.Top, Height = 30, AutoSize = false };
    readonly ListBox lista = new() { Dock = DockStyle.Fill, DrawMode = DrawMode.OwnerDrawFixed, ItemHeight = 46, BorderStyle = BorderStyle.None, IntegralHeight = false };
    readonly Label pie = new() { Dock = DockStyle.Right, Width = 440, TextAlign = ContentAlignment.MiddleRight, AutoEllipsis = true, Font = Tema.Pequena };
    readonly Button botonActualizar;
    readonly ContextMenuStrip menu = new();
    readonly ToolTip ayudas = new();

    readonly Panel barra = new() { Dock = DockStyle.Bottom, Height = 46, BackColor = Panel1, Padding = new Padding(8, 6, 8, 6) };
    readonly Label estado = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true, Text = "Elige un partido o un canal" };
    readonly TrackBar volumen = new() { Dock = DockStyle.Right, Width = 130, Minimum = 0, Maximum = 100, TickStyle = TickStyle.None, AutoSize = false, Height = 30 };
    readonly FlowLayoutPanel botonesBarra = new() { Dock = DockStyle.Right, Width = 600, FlowDirection = FlowDirection.LeftToRight, WrapContents = false };

    enum Seccion { Hoy, Agenda, Canales, Favoritos }
    VistaAgenda vistaAgenda = null!;
    bool soloVideo;        // se está viendo un canal que se ha puesto desde Hoy o Agenda: la lista de canales no se abre sola
    bool listaForzada;     // se está buscando con la lista escondida: se enseña mientras se busca, sin cambiar el ajuste
    bool EsVideo => seccion == Seccion.Canales || seccion == Seccion.Favoritos;
    void ParaBuscar() { if (ajustes.ListaOculta) { listaForzada = true; ColocarLateral(); ActualizarRiel(); } }
    void ColocarLateral()
    {
        lateral.Visible = EsVideo && !completa && !ampliado && !soloVideo && (!ajustes.ListaOculta || listaForzada);
        ficha.Visible = EsVideo && !completa && !ampliado && cuerpo.ClientSize.Width >= (lateral.Visible ? 1000 : 700);
        if (bLista != null) { bLista.Text = lateral.Visible ? "Ocultar lista" : "Ver lista"; bAmpliar.Text = ampliado ? "Reducir" : "Ampliar"; }
    }
    sealed record Par(Evento Ev, Canal Canal);
    Seccion seccion = Seccion.Hoy;
    Canal? heroCanal;
    Label? mensajeInicio;
    Panel? heroPanel;
    Panel? heroPlay;
    Label? heroTag, heroTitulo, heroLinea;
    Button? heroVer, heroFav;
    readonly List<(Label Titulo, Label Detalle, Label Ver, List<Tarjeta> Tarjetas)> filasInicio = new();
    readonly System.Windows.Forms.Timer reloj = new() { Interval = 60 * 1000 };

    bool vpnActiva, vpnCambiando;
    readonly System.Windows.Forms.Timer mirarVpn = new() { Interval = 20000 };
    readonly System.Windows.Forms.Timer reintento = new() { Interval = 2500 };
    readonly System.Windows.Forms.Timer ocultarBarra = new() { Interval = 3000 };
    readonly System.Windows.Forms.Timer vigia = new() { Interval = 2000 };
    readonly System.Windows.Forms.Timer refresco = new() { Interval = 5 * 60 * 1000 };

    string srv = "";                                  // la dirección con la que se está hablando ahora (casa o fuera)
    string Srv => srv.Length > 0 ? srv : ajustes.Servidor;
    List<Canal> todos = new();
    List<Evento> agenda = new();
    List<Canal> vistaCanales = new();
    bool agrupado;               // el servidor entrega los canales ya agrupados (si no, lista simple de enlaces)
    bool enAgenda;
    bool cambiandoPestana;

    // Reproducción
    Canal? actual;
    int enlace;                  // cuál de los enlaces del canal está puesto
    int intentos;                // reintentos seguidos de ese enlace
    int enlacesProbados;         // cuántos enlaces distintos se han probado desde la última vez que funcionó
    DateTime abiertoEn = DateTime.MinValue;
    DateTime sonandoDesde = DateTime.MinValue;
    long ultimoTiempo = -1;
    DateTime ultimoAvance = DateTime.MinValue;
    bool haAvanzado;
    int colchon = 6000;                          // colchón de esta emisión (sube solo si la conexión va a trompicones)
    bool enParon;                                // VLC está llenando el colchón ahora mismo
    readonly List<DateTime> parones = new();     // cuándo se ha quedado sin imagen en los últimos 2 minutos
    DateTime ultimoAmpliado = DateTime.MinValue;
    bool motorLocal;                             // se está usando el motor de Ace Stream instalado en este PC
    bool probadoLocal, probandoLocal;
    bool sinServidor;                            // ninguna de las direcciones del servidor ha respondido
    bool manifest;                               // este enlace se abre como lista HLS del motor (más tolerante que el flujo directo)

    bool completa, cursorOculto;
    FormWindowState estadoAntes;
    Rectangle limitesAntes;
    Point ultimoRaton;
    Version? versionNueva;

    static Version VersionPropia => Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0);

    public Ventana()
    {
        Text = "HomeTV";
        BackColor = Fondo;
        ForeColor = Texto;
        Font = new Font("Segoe UI", 10f);
        MinimumSize = new Size(940, 540);
        Size = new Size(1320, 740);
        StartPosition = FormStartPosition.CenterScreen;
        KeyPreview = true;
        try
        {
            using var s = typeof(Ventana).Assembly.GetManifestResourceStream("hometv.ico");
            if (s != null) Icon = new Icon(s);
        }
        catch { /* sin icono */ }

        // Colchón de 4 s contra los baches del P2P; sin título ni atajos propios de VLC
        vlc = new LibVLC("--network-caching=4000", "--live-caching=4000", "--http-reconnect", "--no-video-title-show", "--no-osd", "--quiet");
        reproductor = new MediaPlayer(vlc) { EnableKeyInput = false, EnableMouseInput = false };
        video.MediaPlayer = reproductor;

        // ----- lista de canales y agenda (secciones Canales y Favoritos) -----
        foreach (var c in new Control[] { categorias, filtro, lista }) { c.BackColor = Principal; c.ForeColor = Texto; }
        // «Solo los que funcionan» como interruptor oscuro (la casilla de Windows sale blanca)
        filtro.Appearance = Appearance.Button;
        filtro.FlatStyle = FlatStyle.Flat;
        filtro.FlatAppearance.BorderSize = 0;
        filtro.FlatAppearance.CheckedBackColor = Panel2;
        filtro.FlatAppearance.MouseOverBackColor = Panel1;
        filtro.TextAlign = ContentAlignment.MiddleLeft;
        filtro.Padding = new Padding(4, 0, 0, 0);
        filtro.Paint += (_, e) =>
        {
            var r = new Rectangle(filtro.Width - 46, (filtro.Height - 18) / 2, 36, 18);
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using (var f = Tema.Redondeado(r, 9)) using (var b = new SolidBrush(filtro.Checked ? Acento : Tema.Linea)) e.Graphics.FillPath(b, f);
            using var bola = new SolidBrush(filtro.Checked ? Fondo : Tenue);
            e.Graphics.FillEllipse(bola, filtro.Checked ? r.Right - 16 : r.Left + 2, r.Top + 2, 14, 14);
        };
        // Categorías: lista desplegable pintada en oscuro
        categorias.DrawMode = DrawMode.OwnerDrawFixed;
        categorias.ItemHeight = 22;
        categorias.DrawItem += (_, e) =>
        {
            if (e.Index < 0) return;
            bool sel = (e.State & DrawItemState.Selected) != 0 && (e.State & DrawItemState.ComboBoxEdit) == 0;
            using (var b = new SolidBrush(sel ? Panel2 : Panel1)) e.Graphics.FillRectangle(b, e.Bounds);
            TextRenderer.DrawText(e.Graphics, categorias.Items[e.Index]?.ToString() ?? "", categorias.Font, new Rectangle(e.Bounds.Left + 6, e.Bounds.Top, e.Bounds.Width - 8, e.Bounds.Height), Texto, TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        };
        categorias.BackColor = Panel1;
        pie.ForeColor = Tenue;
        pestanas.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        pestanas.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        pestCanales = Boton("Canales", (_, _) => PonerPestana(false), 100);
        pestAgenda = Boton("◀  Ocultar lista", (_, _) => PonerLista(false), 100, "Esconder la lista para ver el vídeo más grande (tecla L)");
        pestCanales.Dock = DockStyle.Fill; pestAgenda.Dock = DockStyle.Fill;
        pestanas.Controls.Add(pestCanales, 0, 0);
        pestanas.Controls.Add(pestAgenda, 1, 0);
        lateral.Controls.Add(lista);
        lateral.Controls.Add(Hueco(8));
        lateral.Controls.Add(filtro);
        lateral.Controls.Add(Hueco(6));
        lateral.Controls.Add(categorias);
        lateral.Controls.Add(Hueco(8));
        lateral.Controls.Add(pestanas);

        // ----- cabecera: logo, buscador y estado del servidor -----
        var logo = new Panel { BackColor = Acento, Left = 18, Top = 16, Width = 18, Height = 18 };
        var nombre = new Label { Text = "HomeTV", Left = 44, Top = 14, Width = 80, Height = 22, ForeColor = Texto, Font = Tema.Pequena, BackColor = Fondo };
        cajaBuscar.Paint += (_, e) =>
        {
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using var forma = Tema.Redondeado(new Rectangle(0, 0, cajaBuscar.Width - 1, cajaBuscar.Height - 1), 16);
            using (var b = new SolidBrush(Panel1)) e.Graphics.FillPath(b, forma);
            using (var l = new Pen(Tema.Linea)) e.Graphics.DrawPath(l, forma);
            TextRenderer.DrawText(e.Graphics, "\uE721", Tema.IconosPeq, new Rectangle(8, 0, 24, cajaBuscar.Height), Tenue, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        };
        buscar.Left = 36; buscar.Font = Font;
        cajaBuscar.Controls.Add(buscar);
        cajaBuscar.Resize += (_, _) => { buscar.Width = Math.Max(40, cajaBuscar.Width - 52); buscar.Top = Math.Max(0, (cajaBuscar.Height - buscar.Height) / 2); };
        botonActualizar = Boton("", (_, _) => _ = Actualizarse(), 230, "Descarga la versión nueva y reinicia el programa");
        botonActualizar.Dock = DockStyle.None; botonActualizar.Height = 32; botonActualizar.BackColor = Color.FromArgb(34, 92, 60);
        botonActualizar.Visible = false;
        pie.BackColor = Fondo;
        cabecera.Controls.Add(logo);
        cabecera.Controls.Add(nombre);
        cabecera.Controls.Add(cajaBuscar);
        cabecera.Controls.Add(botonActualizar);
        cabecera.Controls.Add(pie);
        cabecera.Resize += (_, _) => ColocarCabecera();

        // ----- menú lateral -----
        // Menú de iconos (Hoy ya incluye la agenda)
        rHoy.Left = 6; rHoy.Top = 8;
        rCanales.Left = 6; rCanales.Top = 58;
        rFavoritos.Left = 6; rFavoritos.Top = 108;
        rLista.Left = 6; rLista.Top = 172;
        rVpn.Left = 6; rAjustes.Left = 6;
        foreach (var r in new[] { rHoy, rCanales, rFavoritos, rLista, rVpn, rAjustes }) riel.Controls.Add(r);
        riel.Resize += (_, _) => { rAjustes.Top = Math.Max(280, riel.ClientSize.Height - 54); rVpn.Top = rAjustes.Top - 50; };
        rHoy.Click += (_, _) => Ir(Seccion.Hoy);
        rCanales.Click += (_, _) => Ir(Seccion.Canales);
        rFavoritos.Click += (_, _) => Ir(Seccion.Favoritos);
        rLista.Click += (_, _) => AlternarLista();
        rVpn.Click += (_, _) => MenuVpn();
        rAjustes.Click += (_, _) => AbrirAjustes();
        ayudas.SetToolTip(rHoy, "Hoy: destacados y la agenda día a día (tecla H)");
        ayudas.SetToolTip(rCanales, "Todos tus canales");
        ayudas.SetToolTip(rFavoritos, "Tus canales favoritos");
        ayudas.SetToolTip(rLista, "Ocultar o mostrar la lista de canales para dejar más sitio al vídeo (tecla L)");
        ayudas.SetToolTip(rAjustes, "Ajustes: servidor, reproducción, interfaz y listas");
        riel.Padding = new Padding(0);

        // ----- barra de abajo -----
        volumen.Value = Math.Clamp(ajustes.Volumen, 0, 100);
        botonesBarra.Controls.Add(Boton("▲", (_, _) => Zapear(-1), 38, "Canal anterior (↑ en pantalla completa)"));
        botonesBarra.Controls.Add(Boton("▼", (_, _) => Zapear(1), 38, "Canal siguiente (↓ en pantalla completa)"));
        bLista = Boton("Ocultar lista", (_, _) => AlternarLista(), 104, "Ocultar o mostrar la lista de canales (tecla L)");
        bAmpliar = Boton("Ampliar", (_, _) => Ampliar(!ampliado), 76, "El vídeo ocupa toda la ventana, sin lista ni ficha (tecla Z)");
        bAudio = Boton("Audio", (_, _) => MenuAudio(), 64, "Pistas de sonido y arreglo si no se oye");
        botonesBarra.Controls.Add(bLista);
        botonesBarra.Controls.Add(bAmpliar);
        botonesBarra.Controls.Add(bAudio);
        botonesBarra.Controls.Add(Boton("Otro enlace", (_, _) => OtroEnlace(), 96, "Probar el siguiente enlace de este canal (E)"));
        botonesBarra.Controls.Add(Boton("Parar", (_, _) => Parar(), 60));
        botonesBarra.Controls.Add(Boton("Pantalla completa", (_, _) => PantallaCompleta(!completa), 128, "Pantalla completa (F o doble clic)"));
        estado.Cursor = Cursors.Hand;
        estado.Click += (_, _) => { if (!EsVideo && actual != null) IrAlVideo(); };
        barra.Controls.Add(estado);
        barra.Controls.Add(botonesBarra);
        barra.Controls.Add(volumen);

        vistaAgenda = new VistaAgenda(ajustes.SoloConCanal) { CanalDe = CanalDe };
        vistaAgenda.Elegido = ev => BeginInvoke(new Action(() => _ = FichaEvento(ev)));
        vistaAgenda.Reproducir = ev => { var c = CanalDe(ev); if (c != null) Poner(c); };
        vistaAgenda.CambioSoloConCanal = v => { ajustes.SoloConCanal = v; ajustes.Guardar(); };
        cuerpo.Controls.Add(video);
        cuerpo.Controls.Add(inicio);
        cuerpo.Controls.Add(vistaAgenda);
        cuerpo.Controls.Add(lateral);
        cuerpo.Controls.Add(ficha);
        MontarFicha();
        cuerpo.Resize += (_, _) => ColocarLateral();
        lista.SelectedIndexChanged += (_, _) => { ficha.Invalidate(); PonerBotonesFicha(); };
        Controls.Add(cuerpo);
        Controls.Add(barra);
        Controls.Add(riel);
        Controls.Add(cabecera);
        inicio.Resize += (_, _) => { if (inicio.Visible) ColocarInicio(); };

        // ----- menú del botón derecho -----
        menu.Renderer = new ToolStripProfessionalRenderer(new ColoresOscuros());
        menu.ForeColor = Texto;
        var mFav = new ToolStripMenuItem("★ Favorito", null, (_, _) => _ = CambiarFavorito());
        var mEnlace = new ToolStripMenuItem("Probar otro enlace", null, (_, _) => OtroEnlace());
        var mTele = new ToolStripMenuItem("📺 Enviar a la tele…", null, (_, _) => { if (lista.SelectedItem is Canal selCanal) _ = EnviarATele(selCanal); else if (lista.SelectedItem is Evento selEvento && CanalDe(selEvento) is { } canalDelEvento) _ = EnviarATele(canalDelEvento); });
        menu.Items.Add(mFav);
        menu.Items.Add(mEnlace);
        menu.Items.Add(mTele);
        menu.Opening += (_, e) =>
        {
            if (lista.SelectedItem is Evento ev)
            {
                mFav.Text = ev.Favorito ? "Quitar el evento de favoritos" : "★ Evento favorito  (Ctrl+D)";
                mEnlace.Visible = false;
                mTele.Enabled = CanalDe(ev) != null;
                return;
            }
            mEnlace.Visible = true;
            if (lista.SelectedItem is not Canal c) { e.Cancel = true; return; }
            mFav.Text = c.Favorito ? "Quitar de favoritos" : "★ Añadir a favoritos  (Ctrl+D)";
            mEnlace.Enabled = actual != null && actual.Clave == c.Clave && c.Enlaces.Count > 1;
            mTele.Enabled = true;
        };
        lista.ContextMenuStrip = menu;
        lista.MouseDown += (_, e) => { if (e.Button == MouseButtons.Right) { int i = lista.IndexFromPoint(e.Location); if (i >= 0) lista.SelectedIndex = i; } };

        // ----- eventos -----
        buscar.TextChanged += (_, _) => AlBuscar();
        categorias.SelectedIndexChanged += (_, _) => { Filtrar(); ActualizarRiel(); };
        filtro.CheckedChanged += (_, _) =>
        {
            if (cambiandoPestana) return;
            if (enAgenda) ajustes.SoloConCanal = filtro.Checked; else ajustes.SoloVivos = filtro.Checked;
            ajustes.Guardar();
            Filtrar();
        };
        lista.DrawItem += PintarFila;
        lista.DoubleClick += (_, _) => { if (lista.SelectedItem is not Evento) ReproducirSeleccionado(); };
        lista.MouseUp += (_, e) =>
        {
            if (e.Button != MouseButtons.Left || !enAgenda) return;
            int i = lista.IndexFromPoint(e.Location);
            if (i >= 0 && lista.Items[i] is Evento ev) { lista.SelectedIndex = i; BeginInvoke(new Action(() => _ = FichaEvento(ev))); }
        };

        volumen.ValueChanged += (_, _) => { reproductor.Volume = volumen.Value; ajustes.Volumen = volumen.Value; };
        volumen.MouseUp += (_, _) => ajustes.Guardar();
        video.DoubleClick += (_, _) => PantallaCompleta(!completa);
        video.MouseMove += (_, e) => { if (completa && e.Location != ultimoRaton) { ultimoRaton = e.Location; EnsenarBarra(); } };
        video.MouseWheel += (_, e) => volumen.Value = Math.Clamp(volumen.Value + (e.Delta > 0 ? 5 : -5), 0, 100);
        reintento.Tick += (_, _) => { reintento.Stop(); if (actual != null) Abrir(); };
        ocultarBarra.Tick += (_, _) => { ocultarBarra.Stop(); if (completa) { barra.Visible = false; if (!cursorOculto) { Cursor.Hide(); cursorOculto = true; } } };
        vigia.Tick += (_, _) => Vigilar();
        vigia.Start();
        refresco.Tick += (_, _) => _ = CargarCanales(false);
        refresco.Start();
        reloj.Tick += (_, _) => { if (seccion == Seccion.Hoy && !completa) ComponerInicio(); if (ficha.Visible) ficha.Invalidate(); };
        reloj.Start();
        mirarVpn.Tick += (_, _) => _ = MirarVpn();
        mirarVpn.Start();

        // Los avisos de VLC llegan en otro hilo: se pasan al de la ventana (y nunca se llama a VLC desde dentro del aviso)
        reproductor.Playing += (_, _) => EnVentana(() =>
        {
            sonandoDesde = DateTime.Now;
            ultimoAvance = DateTime.Now;
            revisarAudioEn = DateTime.Now.AddSeconds(6);
            reproductor.Volume = volumen.Value;
            Estado(TextoSonando());
        });
        reproductor.Buffering += (_, e) => EnVentana(() =>
        {
            if (actual == null) return;
            if (e.Cache < 100)
            {
                Estado($"Cargando {actual.Titulo}…  {e.Cache:0} %");
                if (!enParon) { enParon = true; if (sonandoDesde != DateTime.MinValue && (DateTime.Now - sonandoDesde).TotalSeconds > 15) NotarParon(); }
            }
            else { enParon = false; if (reproductor.IsPlaying) Estado(TextoSonando()); }
        });
        reproductor.EncounteredError += (_, _) => EnVentana(() => Corte("No se puede abrir"));
        reproductor.EndReached += (_, _) => EnVentana(() => Corte("Se ha cortado"));

        PonerPestana(false);
        Ir(Seccion.Hoy);
        AllowDrop = true;
        DragEnter += (_, e) => { if (e.Data?.GetDataPresent(DataFormats.FileDrop) == true) e.Effect = DragDropEffects.Copy; };
        DragDrop += (_, e) =>
        {
            if (e.Data?.GetData(DataFormats.FileDrop) is string[] f && f.Length > 0) _ = AñadirLista(f[0]);
        };
        Shown += async (_, _) =>
        {
            CargarCopiaLocal();
            await ResolverServidor();
            _ = MirarVpn();
            await CargarCanales(false);
            lista.Focus();
            _ = BuscarVersionNueva();
        };
        FormClosing += (_, _) =>
        {
            ajustes.Guardar();
            try { reproductor.Stop(); } catch { /* cerrando */ }
        };
    }

    // ---------- piezas de interfaz ----------
    Button Boton(string texto, EventHandler alPulsar, int ancho, string? ayuda = null)
    {
        var b = new Button { Text = texto, Width = ancho, Height = 32, FlatStyle = FlatStyle.Flat, BackColor = Panel2, ForeColor = Texto, Margin = new Padding(0, 0, 6, 6), TabStop = false };
        b.FlatAppearance.BorderSize = 0;
        b.Click += alPulsar;
        b.Click += (_, _) => lista.Focus();
        if (ayuda != null) ayudas.SetToolTip(b, ayuda);
        return b;
    }
    static Panel Hueco(int alto) => new() { Dock = DockStyle.Top, Height = alto };
    void EnVentana(Action a) { if (!IsDisposed && IsHandleCreated) BeginInvoke(a); }
    void Estado(string t) { estado.Text = t; Text = actual != null ? $"{actual.Titulo} — HomeTV" : "HomeTV"; }
    string TextoSonando()
    {
        if (actual == null) return "";
        string que = actual.Ahora != null ? $"  ·  {actual.Ahora}" : "";
        string cual = actual.Enlaces.Count > 1 ? $"  ·  enlace {enlace + 1} de {actual.Enlaces.Count}" : "";
        string modo = colchon > ajustes.Colchon ? $"  ·  colchón {colchon / 1000} s" : "";
        return $"▶  {actual.Titulo}{que}{cual}{modo}";
    }

    void PonerPestana(bool deAgenda)
    {
        cambiandoPestana = true;
        enAgenda = deAgenda;
        pestCanales.BackColor = deAgenda ? Panel2 : Acento;
        pestCanales.ForeColor = deAgenda ? Texto : Fondo;
        pestAgenda.BackColor = Panel2;
        pestAgenda.ForeColor = Texto;
        categorias.Visible = !deAgenda;
        filtro.Text = "Solo los que funcionan";
        filtro.Checked = deAgenda ? ajustes.SoloConCanal : ajustes.SoloVivos;
        buscar.PlaceholderText = deAgenda ? "Buscar partido o equipo…  (Ctrl+B)" : "Buscar canal…  (Ctrl+B)";
        cambiandoPestana = false;
        Filtrar();
    }

    static Color ColorEstado(string estado, bool tv) => tv ? Color.FromArgb(90, 160, 255) : estado switch
    {
        "alive" => Color.FromArgb(47, 191, 113),
        "no_peers" => Color.FromArgb(230, 180, 34),
        "" => Color.FromArgb(90, 100, 120),
        _ => Color.FromArgb(229, 72, 77),
    };

    void PintarFila(object? s, DrawItemEventArgs e)
    {
        if (e.Index < 0 || e.Index >= lista.Items.Count) return;
        bool sel = (e.State & DrawItemState.Selected) != 0;
        using var fondo = new SolidBrush(sel ? Panel2 : Principal);
        e.Graphics.FillRectangle(fondo, e.Bounds);
        e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        pequenaFuente ??= new Font(Font.FontFamily, 8.5f);
        var pequena = pequenaFuente;
        var r1 = new Rectangle(e.Bounds.Left + 32, e.Bounds.Top + 5, e.Bounds.Width - 38, 20);
        var r2 = new Rectangle(e.Bounds.Left + 32, e.Bounds.Top + 25, e.Bounds.Width - 38, 18);
        const TextFormatFlags corta = TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix;

        if (lista.Items[e.Index] is Canal c)
        {
            bool sonando = actual != null && c.Clave == actual.Clave;
            if (sonando) { using var a = new SolidBrush(Acento); e.Graphics.FillRectangle(a, e.Bounds.Left, e.Bounds.Top + 4, 3, e.Bounds.Height - 8); }
            using (var p = new SolidBrush(ColorEstado(c.Estado, c.EsTv))) e.Graphics.FillEllipse(p, e.Bounds.Left + 12, e.Bounds.Top + 18, 10, 10);
            // A la derecha, cuántos enlaces tiene
            if (c.Enlaces.Count > 1)
            {
                string n = $"{c.Enlaces.Count} enlaces";
                var tam = TextRenderer.MeasureText(n, pequena);
                TextRenderer.DrawText(e.Graphics, n, pequena, new Point(e.Bounds.Right - tam.Width - 8, e.Bounds.Top + 7), Tenue);
                r1.Width -= tam.Width + 10;
            }
            TextRenderer.DrawText(e.Graphics, (c.Favorito ? "★ " : "") + c.Titulo, Font, r1, sonando ? Acento : Texto, corta);
            if (c.Ahora != null) TextRenderer.DrawText(e.Graphics, "● " + c.Ahora, pequena, r2, Directo, corta);
            else if (c.Luego != null) TextRenderer.DrawText(e.Graphics, c.Luego, pequena, r2, Tenue, corta);
            else
            {
                string detalle = c.EsTv ? "TV" : c.Estado switch { "alive" => $"vivo · {c.Peers} peers", "no_peers" => "sin peers", "" => "sin comprobar", _ => "no funciona" };
                TextRenderer.DrawText(e.Graphics, (c.Apagada ? "lista apagada · " : "") + (string.IsNullOrEmpty(c.Categoria) ? detalle : $"{c.Categoria} · {detalle}"), pequena, r2, Tenue, corta);
            }
        }
        else if (lista.Items[e.Index] is Evento ev)
        {
            var canal = CanalDe(ev);
            using (var p = new SolidBrush(canal != null ? ColorEstado(canal.Estado, canal.EsTv) : Color.FromArgb(60, 70, 90))) e.Graphics.FillEllipse(p, e.Bounds.Left + 12, e.Bounds.Top + 18, 10, 10);
            string dia = ev.Inicio.Date == DateTime.Today ? "" : ev.Inicio.Date == DateTime.Today.AddDays(1) ? "Mañana " : ev.Inicio.ToString("ddd ");
            string cuando = ev.Aplazado ? "APLAZADO" : ev.Vivo ? "EN DIRECTO" : dia + ev.Inicio.ToString("HH:mm");
            var tam = TextRenderer.MeasureText(cuando, pequena);
            TextRenderer.DrawText(e.Graphics, cuando, pequena, new Point(e.Bounds.Right - tam.Width - 8, e.Bounds.Top + 7), ev.Vivo && !ev.Aplazado ? Directo : Tenue);
            r1.Width -= tam.Width + 10;
            TextRenderer.DrawText(e.Graphics, (ev.Favorito ? "★ " : "") + ev.Titulo.Replace(" - ", " – "), Font, r1, ev.Favorito ? Acento : canal != null ? Texto : Tenue, corta);
            string donde = canal != null ? (ev.Posible ? $"¿{canal.Titulo}?" : canal.Titulo + (canal.Apagada ? " (lista apagada)" : "")) : (ev.Canales.Length > 0 ? $"no lo tienes · {ev.Canales}" : "sin canal");
            TextRenderer.DrawText(e.Graphics, $"{ev.Competicion} · {donde}", pequena, r2, Tenue, corta);
        }
    }

    // ---------- secciones del menú lateral ----------
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Nativo.BarraOscura(Handle);
        Nativo.Oscurecer(this);
    }

    // ---------- ficha del canal (derecha de Canales y Favoritos) ----------
    readonly List<Rectangle> sitiosEnlaces = new();   // dónde se ha pintado cada enlace en la ficha (para elegirlo con el ratón)
    int enlaceEncima = -1;
    Canal? CanalFicha() => lista.SelectedItem as Canal ?? (lista.SelectedItem is Evento e ? CanalDe(e) : null) ?? actual;

    void MontarFicha()
    {
        foreach (var b in new[] { fichaVer, fichaFav, fichaTele, fichaGrabar })
        {
            b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderSize = 0; b.Height = 38; b.TabStop = false; b.Cursor = Cursors.Hand;
            b.BackColor = Panel2; b.ForeColor = Texto; b.Font = Tema.Normal;
            ficha.Controls.Add(b);
        }
        fichaVer.BackColor = Acento; fichaVer.ForeColor = Fondo; fichaVer.Font = Tema.Negrita; fichaVer.Text = "▶  Ver ahora";
        fichaTele.Text = "Enviar a la tele";
        fichaGrabar.Text = "⏺  Grabar…";
        fichaGrabar.Click += (_, _) => MenuGrabarCanal(fichaGrabar);
        fichaVer.Click += (_, _) => { if (CanalFicha() is { } c) Poner(c); };
        fichaFav.Click += async (_, _) => { if (CanalFicha() is { } c) { await CambiarFavorito(c); PonerBotonesFicha(); ficha.Invalidate(); } };
        fichaTele.Click += (_, _) => { if (CanalFicha() is { } c) _ = EnviarATele(c); };
        ficha.Resize += (_, _) => PonerBotonesFicha();
        ficha.Paint += PintarFicha;
        // Clic en un enlace de la ficha: se pone ese enlace
        ficha.MouseMove += (_, e) =>
        {
            int i = sitiosEnlaces.FindIndex(r => r.Contains(e.Location));
            if (i == enlaceEncima) return;
            enlaceEncima = i;
            ficha.Cursor = i >= 0 ? Cursors.Hand : Cursors.Default;
            ayudas.SetToolTip(ficha, i >= 0 ? $"Ver el enlace {i + 1}" : "");
            ficha.Invalidate();
        };
        ficha.MouseLeave += (_, _) => { if (enlaceEncima >= 0) { enlaceEncima = -1; ficha.Cursor = Cursors.Default; ficha.Invalidate(); } };
        ficha.MouseClick += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            int i = sitiosEnlaces.FindIndex(r => r.Contains(e.Location));
            if (i < 0 || CanalFicha() is not { } c || i >= c.Enlaces.Count) return;
            if (actual != null && actual.Clave == c.Clave)
            {
                enlace = i; intentos = 0; enlacesProbados = 0; manifest = false; viaAac = false; pistasProbadas = 0;
                Abrir();
            }
            else Poner(c, i);
            ficha.Invalidate();
        };
        SetStyleDoble(ficha);
    }

    static void SetStyleDoble(Control c) =>
        typeof(Control).GetProperty("DoubleBuffered", BindingFlags.NonPublic | BindingFlags.Instance)?.SetValue(c, true);

    void PonerBotonesFicha()
    {
        int W = ficha.ClientSize.Width - 36, y = ficha.ClientSize.Height - 18 - 38;
        fichaFav.SetBounds(18, y, (W - 8) / 2, 38);
        fichaTele.SetBounds(18 + (W - 8) / 2 + 8, y, (W - 8) / 2, 38);
        fichaGrabar.SetBounds(18, y - 46, W, 38);
        fichaVer.SetBounds(18, y - 92, W, 38);
        var c = CanalFicha();
        foreach (var b in new[] { fichaVer, fichaFav, fichaTele, fichaGrabar }) b.Visible = c != null;
        if (c != null)
        {
            fichaFav.Text = c.Favorito ? "★  Favorito" : "☆  Favorito";
            fichaVer.Text = actual != null && actual.Clave == c.Clave ? "↻  Volver a abrir" : "▶  Ver ahora";
        }
    }

    void PintarFicha(object? s, PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Principal);
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        using (var l = new Pen(Tema.Linea)) g.DrawLine(l, 0, 0, 0, ficha.Height);
        const TextFormatFlags corta = TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter;
        const TextFormatFlags varias = TextFormatFlags.WordBreak | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding;
        int W = ficha.ClientSize.Width - 36, x = 18, y = 20;
        var c = CanalFicha();
        sitiosEnlaces.Clear();
        if (c == null)
        {
            TextRenderer.DrawText(g, "Elige un canal de la lista para ver aquí su estado, qué echan y sus enlaces.", Tema.Normal, new Rectangle(x, y, W, 80), Tenue, varias);
            return;
        }
        // Cabecera: iniciales, nombre y categoría
        var logo = new Rectangle(x, y, 48, 48);
        using (var f = Tema.Redondeado(logo, 8)) using (var b = new SolidBrush(Panel2)) g.FillPath(b, f);
        string ini = new string(c.Titulo.Where(char.IsLetterOrDigit).Take(2).ToArray()).ToUpperInvariant();
        TextRenderer.DrawText(g, ini.Length > 0 ? ini : "TV", Tema.Negrita, logo, Acento, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        TextRenderer.DrawText(g, c.Titulo, Tema.Negrita, new Rectangle(x + 60, y + 2, W - 60, 24), Texto, corta);
        TextRenderer.DrawText(g, c.Categoria.Length > 0 ? c.Categoria : "Sin categoría", Tema.Pequena, new Rectangle(x + 60, y + 28, W - 60, 18), Tenue, corta);
        y += 66;
        // Estado
        Color punto = c.EsTv || c.Vivo ? Color.FromArgb(90, 200, 120) : c.Estado == "no_peers" ? Color.FromArgb(230, 190, 70) : c.Estado == "mal" ? Color.FromArgb(229, 72, 77) : Color.FromArgb(150, 150, 150);
        string est = c.EsTv ? "En abierto" : c.Vivo ? $"Vivo{(c.Peers > 0 ? $" · {c.Peers} peers" : "")}" : c.Estado == "no_peers" ? "Sin peers" : c.Estado == "mal" ? "Caído" : "Sin comprobar";
        if (actual != null && actual.Clave == c.Clave) est += " · viéndolo";
        using (var p = new SolidBrush(punto)) g.FillEllipse(p, x, y + 6, 9, 9);
        TextRenderer.DrawText(g, est, Tema.Normal, new Rectangle(x + 16, y, W - 16, 22), Texto, corta);
        y += 34;
        // Ahora (con barra de progreso si es un evento de la agenda en directo)
        if (!string.IsNullOrWhiteSpace(c.Ahora))
        {
            var caja = new Rectangle(x, y, W, 86);
            using (var f = Tema.Redondeado(caja, 8)) using (var b = new SolidBrush(Panel1)) g.FillPath(b, f);
            TextRenderer.DrawText(g, "AHORA", Tema.Pequena, new Rectangle(x + 12, y + 10, W - 24, 16), Tenue, corta);
            TextRenderer.DrawText(g, c.Ahora!, Tema.Negrita, new Rectangle(x + 12, y + 28, W - 24, 40), Texto, varias);
            var ev = agenda.FirstOrDefault(a => a.Vivo && !a.Aplazado && a.Claves.Contains(c.Clave));
            if (ev != null)
            {
                double prog = Math.Clamp((DateTime.Now - ev.Inicio).TotalMinutes / 120.0, 0.02, 1);
                using (var b = new SolidBrush(Tema.Linea)) g.FillRectangle(b, x + 12, y + 72, W - 24, 4);
                using (var b = new SolidBrush(Acento)) g.FillRectangle(b, x + 12, y + 72, (int)((W - 24) * prog), 4);
            }
            y += 98;
        }
        if (!string.IsNullOrWhiteSpace(c.Luego))
        {
            TextRenderer.DrawText(g, "DESPUÉS", Tema.Pequena, new Rectangle(x, y, W, 16), Tenue, corta);
            TextRenderer.DrawText(g, c.Luego!, Tema.Normal, new Rectangle(x, y + 20, W, 40), Texto, varias);
            y += 66;
        }
        // Enlaces
        int tope = ficha.ClientSize.Height - 18 - 38 - 92 - 16;
        if (c.Enlaces.Count > 0 && y + 40 < tope)
        {
            TextRenderer.DrawText(g, c.Enlaces.Count == 1 ? "ENLACE" : $"ENLACES ({c.Enlaces.Count}) · clic para cambiar", Tema.Pequena, new Rectangle(x, y, W, 16), Tenue, corta);
            y += 22;
            for (int i = 0; i < c.Enlaces.Count && y + 26 < tope; i++)
            {
                var en = c.Enlaces[i];
                bool puesto = actual != null && actual.Clave == c.Clave && enlace == i;
                var fila = new Rectangle(x - 8, y - 3, W + 16, 26);
                sitiosEnlaces.Add(fila);
                if (i == enlaceEncima || puesto)
                {
                    using var f = Tema.Redondeado(fila, 6);
                    using var b = new SolidBrush(i == enlaceEncima ? Panel2 : Panel1);
                    g.FillPath(b, f);
                }
                Color pe = en.Url != null || en.Estado == "alive" ? Color.FromArgb(90, 200, 120) : en.Estado == "no_peers" ? Color.FromArgb(230, 190, 70) : en.Estado.Length == 0 ? Color.FromArgb(150, 150, 150) : Color.FromArgb(229, 72, 77);
                using (var p = new SolidBrush(pe)) g.FillEllipse(p, x, y + 6, 8, 8);
                string txt = $"{(puesto ? "▶ " : "")}Enlace {i + 1}{(en.Url != null ? " · TV" : en.Peers > 0 ? $" · {en.Peers} peers" : en.Estado == "no_peers" ? " · sin peers" : "")}";
                TextRenderer.DrawText(g, txt, Tema.Normal, new Rectangle(x + 16, y, W - 16, 20), puesto ? Acento : Texto, corta);
                if (i == enlaceEncima && !puesto) TextRenderer.DrawText(g, "▶ Ver", Tema.Pequena, new Rectangle(x, y, W, 20), Acento, corta | TextFormatFlags.Right);
                y += 28;
            }
        }
    }

    void Ir(Seccion s)
    {
        if (s == Seccion.Agenda) s = Seccion.Hoy;   // la agenda está dentro de Hoy
        seccion = s;
        soloVideo = false;
        listaForzada = false;
        bool video_ = s == Seccion.Canales || s == Seccion.Favoritos;
        inicio.Visible = false;
        vistaAgenda.Visible = s == Seccion.Hoy;
        video.Visible = video_;
        ColocarLateral();
        if (video_)
        {
            if (s == Seccion.Favoritos)
            {
                if (enAgenda) PonerPestana(false);
                if (categorias.Items.Count > 1) categorias.SelectedIndex = 1;
            }
            else if (categorias.SelectedIndex == 1) categorias.SelectedIndex = 0;
            Filtrar();
            lista.Focus();
        }
        else { vistaAgenda.Cargar(agenda); ComponerInicio(); vistaAgenda.Enfocar(); }
        ActualizarRiel();
    }

    // Poner un canal desde Hoy o Agenda: se ve el vídeo solo, sin que se abra la lista de canales
    void IrAlVideo()
    {
        if (EsVideo) return;
        Ir(Seccion.Canales);
        soloVideo = true;
        ColocarLateral();
        ActualizarRiel();
    }

    void ActualizarRiel()
    {
        bool favs = categorias.SelectedIndex == 1;
        rHoy.Activo = seccion == Seccion.Hoy;
        rCanales.Activo = EsVideo && !favs;
        rFavoritos.Activo = EsVideo && favs;
        rLista.Encendido = lateral.Visible;
        rLista.Enabled = EsVideo;
        rHoy.Invalidate(); rCanales.Invalidate(); rFavoritos.Invalidate(); rLista.Invalidate();
    }

    // Escribir en el buscador desde «Hoy» lleva a la lista: a canales si hay un canal con ese nombre, y si no a la agenda (equipos)
    void AlBuscar()
    {

        if (ajustes.ListaOculta && EsVideo) { if (buscar.Text.Trim().Length > 0) { listaForzada = true; ColocarLateral(); ActualizarRiel(); } }
        if (seccion == Seccion.Hoy && buscar.Text.Trim().Length > 0)
        {
            var palabras = SinTildes(buscar.Text).Split(' ', StringSplitOptions.RemoveEmptyEntries);
            bool esCanal = todos.Any(c => palabras.All(p => SinTildes(c.Titulo).Contains(p)));
            if (!esCanal) { vistaAgenda.Texto = buscar.Text; return; }   // un equipo o partido: se busca en la agenda de Hoy
            Ir(Seccion.Canales);
            ParaBuscar();
            if (enAgenda) PonerPestana(false);
            buscar.Focus();
            buscar.SelectionStart = buscar.Text.Length;
            return;
        }
        if (seccion == Seccion.Hoy) { vistaAgenda.Texto = ""; return; }
        // Si escribes estando en Favoritos, se sale de ahí para buscar en todos los canales
        if (buscar.Text.Trim().Length > 0 && (seccion == Seccion.Favoritos || categorias.SelectedIndex == 1))
        {
            Ir(Seccion.Canales);
            ParaBuscar();
            buscar.Focus();
            buscar.SelectionStart = buscar.Text.Length;
            return;
        }
        Filtrar();
    }

    void ColocarCabecera()
    {
        int derecha = pie.Width + (botonActualizar.Visible ? botonActualizar.Width + 16 : 0) + 20;
        int libre = cabecera.ClientSize.Width - 150 - derecha;
        int ancho = Math.Clamp(libre, 200, 480);
        int izq = Math.Max(150, (cabecera.ClientSize.Width - ancho) / 2);
        if (izq + ancho > cabecera.ClientSize.Width - derecha) izq = 150;
        cajaBuscar.SetBounds(izq, 8, ancho, 34);
        botonActualizar.SetBounds(cabecera.ClientSize.Width - pie.Width - botonActualizar.Width - 12, 9, botonActualizar.Width, 32);
    }

    // ---------- inicio: los partidos de hoy en mis canales ----------
    static string Ver(int n, string uno, string varios) => n == 1 ? uno : varios;

    // Hoy: los tres mejores eventos del día con canal mío (en directo y vivos primero) encima de la agenda
    void ComponerInicio()
    {
        if (IsDisposed) return;
        var ahora = DateTime.Now;
        var pares = agenda.Where(e => !e.Aplazado && (e.Vivo || (e.Inicio > ahora && e.Inicio.Date == ahora.Date)))
            .Select(e => (Ev: e, Canal: CanalDe(e)!)).Where(x => x.Canal != null && !x.Canal.Apagada && !x.Ev.Posible)
            .Select(x => (x.Ev, x.Canal, Nota: (x.Ev.Vivo ? 50 : 0) + (x.Canal.Vivo ? 30 : 0) + (x.Ev.Favorito ? 25 : 0) + (x.Canal.Favorito ? 10 : 0) - (x.Ev.Vivo ? 0 : (x.Ev.Inicio - ahora).TotalHours)))
            .OrderByDescending(x => x.Nota).Take(3).OrderBy(x => x.Ev.Inicio).Select(x => (x.Ev, x.Canal)).ToList();
        vistaAgenda.PonerDestacados(pares);
        vistaAgenda.Repintar();
    }

    Button BotonGrande(string texto, bool principal)
    {
        var b = new Button { Text = texto, Height = 38, FlatStyle = FlatStyle.Flat, BackColor = principal ? Acento : Panel2, ForeColor = principal ? Fondo : Texto, Font = Tema.Negrita, TabStop = false, Cursor = Cursors.Hand };
        b.FlatAppearance.BorderSize = 0;
        b.Width = TextRenderer.MeasureText(texto, b.Font).Width + 36;
        return b;
    }

    void AñadirFila(string titulo, string detalle, List<Par> partidos)
    {
        var t = new Label { Text = titulo, ForeColor = Texto, Font = Tema.Seccion, AutoSize = false, BackColor = Principal };
        var d = new Label { Text = detalle, ForeColor = Tenue, Font = Tema.Normal, AutoSize = false, BackColor = Principal };
        var ver = new Label { Text = "Ver agenda", ForeColor = Acento, Font = Tema.Normal, AutoSize = false, TextAlign = ContentAlignment.TopRight, Cursor = Cursors.Hand, BackColor = Principal };
        ver.Click += (_, _) => Ir(Seccion.Agenda);
        var tarjetas = new List<Tarjeta>();
        foreach (var x in partidos.Take(12))
        {
            var tj = new Tarjeta(x.Ev, x.Canal);
            var canal = x.Canal;
            tj.Click += (_, _) => Poner(canal);
            tarjetas.Add(tj);
        }
        inicio.Controls.Add(t); inicio.Controls.Add(d); inicio.Controls.Add(ver);
        foreach (var tj in tarjetas) inicio.Controls.Add(tj);
        filasInicio.Add((t, d, ver, tarjetas));
    }

    void ColocarInicio()
    {
        int margen = 26;
        int W = Math.Max(300, inicio.ClientSize.Width - margen * 2);
        int y = margen;
        inicio.SuspendLayout();
        if (mensajeInicio != null) { mensajeInicio.SetBounds(margen, y, W, 60); y += 70; }
        if (heroPanel != null)
        {
            heroPanel.SetBounds(margen, y, W, 210);
            bool conVista = W >= 760;
            heroPlay!.Visible = conVista;
            int ancho = W - (conVista ? heroPlay.Width : 0) - 56;
            heroTag!.SetBounds(28, 26, ancho, 20);
            heroTitulo!.SetBounds(28, 50, ancho, 52);
            heroLinea!.SetBounds(28, 108, ancho, 24);
            heroVer!.Location = new Point(28, 150);
            heroFav!.Location = new Point(28 + heroVer.Width + 10, 150);
            y += 210 + 26;
        }
        foreach (var f in filasInicio)
        {
            f.Titulo.SetBounds(margen, y, 220, 30);
            int tit = TextRenderer.MeasureText(f.Titulo.Text, f.Titulo.Font).Width;
            f.Titulo.Width = tit + 6;
            f.Detalle.SetBounds(margen + tit + 16, y + 6, Math.Max(40, W - tit - 160), 24);
            f.Ver.SetBounds(margen + W - 110, y + 6, 110, 24);
            y += 40;
            int hueco = 12;
            int cols = Math.Max(1, (W + hueco) / (230 + hueco));
            int ancho = (W - hueco * (cols - 1)) / cols;
            for (int i = 0; i < f.Tarjetas.Count; i++)
                f.Tarjetas[i].SetBounds(margen + (i % cols) * (ancho + hueco), y + (i / cols) * (176 + hueco), ancho, 176);
            int filas = (f.Tarjetas.Count + cols - 1) / cols;
            y += filas * (176 + hueco) + 14;
        }
        inicio.AutoScrollMinSize = new Size(0, y + margen);
        inicio.ResumeLayout();
    }

    // ---------- canales ----------
    // Casa primero; si no responde enseguida, la de fuera (Tailscale)
    async Task ResolverServidor()
    {
        string casa = ajustes.Servidor, fuera = ajustes.ServidorExterno;
        if (fuera.Length == 0 || fuera == casa) { srv = casa; return; }
        foreach (var d in new[] { casa, fuera })
        {
            try
            {
                using var c = new CancellationTokenSource(2500);
                using var r = await http.GetAsync($"http://{d}:8096/api/estado", c.Token);
                if (r.IsSuccessStatusCode) { srv = d; return; }
            }
            catch { /* esa no responde: se prueba la otra */ }
        }
        if (srv.Length == 0) srv = casa;
    }

    async Task<bool> ServidorResponde()
    {
        try
        {
            using var c = new CancellationTokenSource(3000);
            using var r = await http.GetAsync($"http://{Srv}:8096/api/estado", c.Token);
            return r.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    async Task CargarCanales(bool avisar)
    {
        await ResolverServidor();
        sinServidor = !await ServidorResponde();
        if (avisar) pie.Text = $"Conectando con {Srv}…";
        try
        {
            string json;
            bool simple = true;
            using (var r = await http.GetAsync($"http://{Srv}:8096/api/simple"))
            {
                if (r.IsSuccessStatusCode) json = await r.Content.ReadAsStringAsync();
                else { simple = false; json = await http.GetStringAsync($"http://{Srv}:8096/sincro"); }   // servidor sin actualizar
            }
            Leer(json);
            if (todos.Count == 0) throw new Exception("el servidor no tiene canales");
            try { Directory.CreateDirectory(Path.GetDirectoryName(Ajustes.ArchivoCanales)!); File.WriteAllText(Ajustes.ArchivoCanales, json); } catch { /* sin copia local */ }
            RellenarCategorias();
            Filtrar();
            ComponerInicio();
            if (seccion == Seccion.Hoy) vistaAgenda.Cargar(agenda);
            pieBase = $"{Srv}{(Srv == ajustes.ServidorExterno ? " (Tailscale)" : "")} · {todos.Count(c => !c.Apagada)} canales · {todos.Count(c => c.Vivo && !c.Apagada)} funcionan" + (simple ? "" : " · servidor sin actualizar");
            ActualizarPie();
        }
        catch (Exception e)
        {
            pieBase = todos.Count > 0 ? $"Sin conexión con {Srv} (lista guardada)" : $"Sin conexión con {Srv}";
            ActualizarPie();
            if (avisar || todos.Count == 0)
            {
                var r = MessageBox.Show(this, $"No se ha podido leer la lista de canales de {Srv}.\n\n{e.Message}\n\n¿Quieres cambiar la dirección del servidor?\n(En casa: 192.168.1.180 · Fuera, con Tailscale: la IP que empieza por 100.)",
                    "HomeTV", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (r == DialogResult.Yes) PedirServidor();
            }
        }
    }

    void CargarCopiaLocal()
    {
        try
        {
            Leer(File.ReadAllText(Ajustes.ArchivoCanales));
            RellenarCategorias();
            Filtrar();
            ComponerInicio();
        }
        catch { /* primera vez */ }
    }

    static string Cadena(JsonElement o, string clave)
        => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(clave, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
    static bool Cierto(JsonElement o, string clave)
        => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(clave, out var v) && v.ValueKind == JsonValueKind.True;
    static string? CadenaONada(JsonElement o, string clave) { string t = Cadena(o, clave); return t.Length > 0 ? t : null; }

    // Entiende las dos respuestas: la agrupada (/api/simple) y la de siempre (/sincro, un canal por enlace)
    void Leer(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var raiz = doc.RootElement;
        var canales = new List<Canal>();
        var eventos = new List<Evento>();
        bool esSimple = raiz.TryGetProperty("canales", out var cs) && cs.ValueKind == JsonValueKind.Array;
        if (esSimple)
        {
            foreach (var c in cs.EnumerateArray())
            {
                var canal = new Canal { Clave = Cadena(c, "clave"), Titulo = Cadena(c, "titulo"), Categoria = Cadena(c, "categoria"), Favorito = Cierto(c, "favorito"), Apagada = Cierto(c, "apagada"), Ahora = CadenaONada(c, "ahora"), Luego = CadenaONada(c, "luego") };
                if (c.TryGetProperty("enlaces", out var es) && es.ValueKind == JsonValueKind.Array)
                    foreach (var x in es.EnumerateArray())
                    {
                        var en = new Enlace { Id = Cadena(x, "id"), Titulo = Cadena(x, "titulo"), Tipo = Cadena(x, "kind"), Estado = Cadena(x, "estado") };
                        string url = Cadena(x, "url");
                        if (url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) en.Url = url;
                        if (x.TryGetProperty("peers", out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetInt32(out int n)) en.Peers = n;
                        if (en.Id.Length > 0) canal.Enlaces.Add(en);
                    }
                if (canal.Clave.Length > 0 && canal.Titulo.Length > 0 && canal.Enlaces.Count > 0) canales.Add(canal);
            }
            if (raiz.TryGetProperty("agenda", out var ag) && ag.ValueKind == JsonValueKind.Array)
                foreach (var x in ag.EnumerateArray())
                {
                    if (!x.TryGetProperty("inicio", out var ini) || ini.ValueKind != JsonValueKind.Number || !ini.TryGetInt64(out long ms)) continue;
                    var ev = new Evento { Id = Cadena(x, "id"), Inicio = DateTimeOffset.FromUnixTimeMilliseconds(ms).LocalDateTime, Titulo = Cadena(x, "titulo"), Competicion = Cadena(x, "competicion"), Deporte = Cadena(x, "deporte"), Aplazado = Cierto(x, "aplazado"), Posible = Cierto(x, "posible"), Favorito = Cierto(x, "fav") };
                    ev.Vivo = !ev.Aplazado && ev.Inicio <= DateTime.Now;
                    if (x.TryGetProperty("canales", out var nom) && nom.ValueKind == JsonValueKind.Array)
                        ev.Canales = string.Join(" · ", nom.EnumerateArray().Select(n => n.ValueKind == JsonValueKind.String ? n.GetString() ?? "" : "").Where(n => n.Length > 0).Take(4));
                    if (x.TryGetProperty("ace", out var ac) && ac.ValueKind == JsonValueKind.Array)
                        foreach (var a in ac.EnumerateArray())
                        {
                            string idAce = Cadena(a, "id");
                            if (idAce.Length > 0) ev.Ace.Add((idAce, Cadena(a, "label")));
                        }
                    if (x.TryGetProperty("enlaces", out var en2) && en2.ValueKind == JsonValueKind.Array)
                        ev.Enlaces = en2.EnumerateArray().Select(n => n.ValueKind == JsonValueKind.String ? n.GetString() ?? "" : "").Where(n => n.StartsWith("http", StringComparison.OrdinalIgnoreCase)).ToList();
                    if (x.TryGetProperty("claves", out var cl) && cl.ValueKind == JsonValueKind.Array)
                        ev.Claves = cl.EnumerateArray().Select(n => n.ValueKind == JsonValueKind.String ? n.GetString() ?? "" : "").Where(n => n.Length > 0).ToList();
                    eventos.Add(ev);
                }
        }
        else
        {
            var datos = raiz.TryGetProperty("datos", out var d) && d.ValueKind == JsonValueKind.Object ? d : raiz;
            var apagadas = new HashSet<string>();
            if (datos.TryGetProperty("sources", out var fuentes) && fuentes.ValueKind == JsonValueKind.Array)
                foreach (var f in fuentes.EnumerateArray())
                    if (f.TryGetProperty("enabled", out var en) && en.ValueKind == JsonValueKind.False) apagadas.Add(Cadena(f, "id"));
            if (datos.TryGetProperty("channels", out var chs) && chs.ValueKind == JsonValueKind.Array)
                foreach (var c in chs.EnumerateArray())
                {
                    if (c.TryGetProperty("oculto", out var oc) && oc.ValueKind is JsonValueKind.String or JsonValueKind.True) continue;
                    if (c.TryGetProperty("listas", out var ls) && ls.ValueKind == JsonValueKind.Array && ls.GetArrayLength() > 0
                        && !ls.EnumerateArray().Any(l => l.ValueKind == JsonValueKind.String && !apagadas.Contains(l.GetString() ?? ""))) continue;
                    var en = new Enlace { Id = Cadena(c, "id"), Titulo = Cadena(c, "title"), Tipo = Cadena(c, "kind") };
                    string url = Cadena(c, "url");
                    if (url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) en.Url = url;
                    if (c.TryGetProperty("checks", out var ch) && ch.ValueKind == JsonValueKind.Array && ch.GetArrayLength() > 0)
                    {
                        en.Estado = Cadena(ch[0], "status");
                        if (ch[0].TryGetProperty("peers", out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetInt32(out int n)) en.Peers = n;
                    }
                    if (en.Id.Length == 0 || en.Titulo.Length == 0) continue;
                    var canal = new Canal { Clave = en.Id, Titulo = en.Titulo, Categoria = Cadena(c, "category"), Favorito = Cierto(c, "favorite") };
                    canal.Enlaces.Add(en);
                    canales.Add(canal);
                }
        }
        agrupado = esSimple;
        todos = canales.OrderBy(c => c.Raro).ThenBy(c => c.Titulo, StringComparer.CurrentCultureIgnoreCase).ToList();
        agenda = eventos;
        // El canal que está puesto se enlaza con sus datos nuevos (sin cortar la reproducción)
        if (actual != null)
        {
            var nuevo = todos.FirstOrDefault(c => c.Clave == actual.Clave);
            if (nuevo != null)
            {
                string idPuesto = enlace < actual.Enlaces.Count ? actual.Enlaces[enlace].Id : "";
                int i = nuevo.Enlaces.FindIndex(x => x.Id == idPuesto);
                if (i >= 0) { actual = nuevo; enlace = i; }
                else { actual.Ahora = nuevo.Ahora; actual.Luego = nuevo.Luego; actual.Favorito = nuevo.Favorito; }
            }
        }
    }

    void RellenarCategorias()
    {
        string antes = categorias.SelectedItem as string ?? "";
        categorias.BeginUpdate();
        categorias.Items.Clear();
        categorias.Items.Add("Todas las categorías");
        categorias.Items.Add("★ Favoritos");
        foreach (var cat in todos.Where(c => !c.Apagada).Select(c => c.Categoria).Where(c => c.Length > 0).Distinct(StringComparer.CurrentCultureIgnoreCase).OrderBy(c => c, StringComparer.CurrentCultureIgnoreCase))
            categorias.Items.Add(cat);
        categorias.EndUpdate();
        int i = categorias.Items.IndexOf(antes);
        categorias.SelectedIndex = i >= 0 ? i : 0;
    }

    static string SinTildes(string t)
    {
        var norm = t.Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(norm.Length);
        foreach (char ch in norm)
            if (System.Globalization.CharUnicodeInfo.GetUnicodeCategory(ch) != System.Globalization.UnicodeCategory.NonSpacingMark) sb.Append(char.ToLowerInvariant(ch));
        return sb.ToString();
    }

    // El canal mío por el que se ve un partido: el primero que funcione; si ninguno, el primero que haya
    Canal? CanalDe(Evento ev)
    {
        Canal? primero = null;
        foreach (string k in ev.Claves)
        {
            var c = todos.FirstOrDefault(x => x.Clave == k);
            if (c == null) continue;
            if (c.Vivo) return c;
            primero ??= c;
        }
        return primero;
    }

    void Filtrar()
    {
        var palabras = SinTildes(buscar.Text).Split(' ', StringSplitOptions.RemoveEmptyEntries);
        string cat = categorias.SelectedIndex > 1 ? (string)categorias.SelectedItem! : "";
        bool favs = categorias.SelectedIndex == 1;
        vistaCanales = todos.Where(c =>
            (!c.Apagada || (!enAgenda && palabras.Length > 0 && !favs)) &&   // los de listas apagadas, solo al buscar
            (!ajustes.SoloVivos || c.Apagada || c.Vivo || (actual != null && c.Clave == actual.Clave)) &&
            (!favs || c.Favorito) &&
            (cat.Length == 0 || string.Equals(c.Categoria, cat, StringComparison.CurrentCultureIgnoreCase)) &&
            (favs || enAgenda || palabras.Length == 0 || palabras.All(p => SinTildes(c.Titulo).Contains(p)))).ToList();   // en Favoritos no se aplica lo escrito en el buscador

        object? antes = lista.SelectedItem;
        int arriba = lista.TopIndex;
        lista.BeginUpdate();
        lista.Items.Clear();
        if (enAgenda)
        {
            var evs = agenda.Where(ev =>
                (!favs || ev.Favorito) &&
                (favs || palabras.Length > 0 || !ajustes.SoloConCanal || CanalDe(ev) != null) &&
                (favs || palabras.Length == 0 || palabras.All(p => SinTildes(ev.Titulo + " " + ev.Competicion + " " + ev.Deporte).Contains(p)))).ToArray();
            lista.Items.AddRange(evs);
            if (favs && evs.Length == 0) Estado("No tienes eventos favoritos: haz clic en un evento y márcalo (o Ctrl+D).");
            int i = antes is Evento ea ? Array.FindIndex(evs, x => x.Id == ea.Id) : -1;
            if (evs.Length > 0) lista.SelectedIndex = i >= 0 ? i : 0;
            if (i >= 0 && arriba < evs.Length) lista.TopIndex = arriba;
        }
        else
        {
            lista.Items.AddRange(vistaCanales.ToArray());
            string clave = (antes as Canal)?.Clave ?? actual?.Clave ?? ajustes.UltimoCanal;
            int i = vistaCanales.FindIndex(c => c.Clave == clave);
            if (vistaCanales.Count > 0) lista.SelectedIndex = i >= 0 ? i : 0;
            if (i >= 0 && antes is Canal && arriba < vistaCanales.Count) lista.TopIndex = arriba;
        }
        lista.EndUpdate();
    }

    // ---------- ajustes ----------
    void AbrirAjustes()
    {
        using var f = new Form { Text = "Ajustes", FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterParent, ClientSize = new Size(560, 600), MinimizeBox = false, MaximizeBox = false, ShowInTaskbar = false, Font = Font };
        var pagina = new FlowLayoutPanel { Left = 0, Top = 0, Width = 560, Height = 540, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(18, 10, 6, 0) };
        Label Titulo(string t) => new() { Text = t, Font = Tema.Negrita, ForeColor = Acento, AutoSize = true, Margin = new Padding(0, 12, 0, 6) };
        Label Nota(string t) => new() { Text = t, ForeColor = Tenue, AutoSize = false, Width = 500, Height = 34, Margin = new Padding(0, 0, 0, 4) };
        Label Etiqueta(string t) => new() { Text = t, AutoSize = true, Margin = new Padding(0, 4, 0, 2) };
        TextBox Caja(string valor, string pista) => new() { Text = valor, PlaceholderText = pista, Width = 500, Margin = new Padding(0, 0, 0, 4) };
        CheckBox Marca(string t, bool v) => new() { Text = t, Checked = v, AutoSize = false, Width = 500, Height = 28, Margin = new Padding(0, 0, 0, 2) };
        ComboBox Opciones(string[] textos, int elegido) { var c = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, FlatStyle = FlatStyle.Flat, Width = 500, Margin = new Padding(0, 0, 0, 4), BackColor = Panel1, ForeColor = Texto }; c.Items.AddRange(textos); c.SelectedIndex = Math.Clamp(elegido, 0, textos.Length - 1); return c; }
        Button Accion(string t, Action a) { var b = new Button { Text = t, Width = 500, Height = 32, Margin = new Padding(0, 0, 0, 6), TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(8, 0, 0, 0) }; b.Click += (_, _) => a(); return b; }

        // Servidor
        var casa = Caja(ajustes.Servidor, "192.168.1.180");
        var fuera = Caja(ajustes.ServidorExterno, "100.x.x.x  (vacío si no usas Tailscale)");
        // Reproducción
        int[] colchones = { 6000, 12000, 20000 };
        var cColchon = Opciones(new[] { "Normal · 6 s", "Grande · 12 s (menos cortes, más retraso)", "Enorme · 20 s" }, Array.IndexOf(colchones, ajustes.Colchon) is var ic && ic >= 0 ? ic : 0);
        string[] motores = { "auto", "servidor", "pc" };
        var cMotor = Opciones(new[] { "Automático: el del servidor y, si falla, el de este PC", "Siempre el del servidor", "Siempre el de este PC (hace falta tener Ace Stream instalado)" }, Math.Max(0, Array.IndexOf(motores, ajustes.MotorLocal)));
        // Interfaz
        var kOculta = Marca("Esconder la lista de canales al ver un canal (más sitio para el vídeo)", ajustes.ListaOculta);
        var kVivos = Marca("En Canales, enseñar solo los que funcionan", ajustes.SoloVivos);
        var kConCanal = Marca("En Agenda, enseñar solo los eventos que puedo ver con mis canales", ajustes.SoloConCanal);

        pagina.Controls.AddRange(new Control[] {
            Titulo("Servidor"), Nota("El programa prueba primero la dirección de casa y, si no responde, la de fuera (Tailscale)."),
            Etiqueta("En casa (red local)"), casa, Etiqueta("Fuera de casa (IP de Tailscale del servidor)"), fuera,
            Accion("Abrir el panel del servidor (mantenimiento, copias, motor)…", () =>
            {
                try { Process.Start(new ProcessStartInfo($"http://{Srv}:8096/") { UseShellExecute = true }); }
                catch (Exception e) { Estado("No se ha podido abrir el panel: " + e.Message); }
            }),
            Titulo("Reproducción"), Etiqueta("Colchón del vídeo"), cColchon, Etiqueta("Motor de Ace Stream"), cMotor,
            Nota("Los cambios de reproducción se aplican al abrir el siguiente canal."),
            Titulo("Interfaz"), kOculta, kVivos, kConCanal,
            Titulo("Listas y datos"),
            Accion("Elegir qué listas de canales están encendidas…", () => _ = ElegirListas()),
            Accion("Añadir una lista (archivo o enlace)…", () => _ = AñadirLista()),
            Accion("Actualizar canales y agenda ahora", () => _ = CargarCanales(true)),
            Accion("Ver las grabaciones del servidor…", () => AbrirWeb($"http://{Srv}:8096/#grabaciones")),
            Titulo("Programa"), Nota($"HomeTV {VersionPropia.Major}.{VersionPropia.Minor}.{Math.Max(VersionPropia.Build, 0)}. Se actualiza solo cuando hay una versión nueva."),
        });
        var ok = new Button { Text = "Guardar", Left = 366, Top = 552, Width = 86, Height = 32, DialogResult = DialogResult.OK };
        var no = new Button { Text = "Cancelar", Left = 460, Top = 552, Width = 86, Height = 32, DialogResult = DialogResult.Cancel };
        f.Controls.AddRange(new Control[] { pagina, ok, no });
        f.AcceptButton = ok; f.CancelButton = no;
        Tema.Aplicar(f);
        foreach (var c in new[] { cColchon, cMotor }) { c.BackColor = Panel1; c.ForeColor = Texto; }
        if (f.ShowDialog(this) != DialogResult.OK) return;

        string c1 = LimpiarDireccion(casa.Text), x1 = LimpiarDireccion(fuera.Text);
        if (c1.Length == 0) c1 = x1;
        bool servidorCambia = c1.Length > 0 && (c1 != ajustes.Servidor || (x1 == c1 ? "" : x1) != ajustes.ServidorExterno);
        if (c1.Length > 0) { ajustes.Servidor = c1; ajustes.ServidorExterno = x1 == c1 ? "" : x1; }
        ajustes.Colchon = colchones[cColchon.SelectedIndex];
        if (actual == null) colchon = ajustes.Colchon;
        ajustes.MotorLocal = motores[cMotor.SelectedIndex];
        ajustes.ListaOculta = kOculta.Checked;
        ajustes.SoloVivos = kVivos.Checked;
        ajustes.SoloConCanal = kConCanal.Checked;
        ajustes.Guardar();
        listaForzada = false;
        ColocarLateral();
        if (seccion == Seccion.Hoy) vistaAgenda.Cargar(agenda);
        PonerPestana(enAgenda);
        ActualizarRiel();
        if (servidorCambia) { srv = ""; _ = CargarCanales(true); _ = MirarVpn(); }
        Estado("Ajustes guardados");
    }

    static string LimpiarDireccion(string t)
    {
        // Se admite pegar la dirección entera (http://…:8096/tv): se queda solo con el nombre o la IP
        t = t.Trim();
        if (t.Contains("://")) t = t[(t.IndexOf("://") + 3)..];
        return t.Split('/')[0].Split(':')[0];
    }

    void PedirServidor()
    {
        using var f = new Form { Text = "Direcciones del servidor", FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterParent, ClientSize = new Size(440, 270), MinimizeBox = false, MaximizeBox = false, Font = Font };
        var nota = new Label { Text = "El programa prueba primero la de casa y, si no responde, la de fuera. Así funciona igual en casa que con Tailscale.", Left = 14, Top = 12, Width = 412, Height = 44 };
        var l1 = new Label { Text = "En casa (red local)", Left = 14, Top = 62, Width = 412, Height = 20 };
        var casa = new TextBox { Text = ajustes.Servidor, Left = 14, Top = 84, Width = 412, PlaceholderText = "192.168.1.180" };
        var l2 = new Label { Text = "Fuera de casa (IP de Tailscale del servidor)", Left = 14, Top = 118, Width = 412, Height = 20 };
        var fuera = new TextBox { Text = ajustes.ServidorExterno, Left = 14, Top = 140, Width = 412, PlaceholderText = "100.x.x.x  (déjalo vacío si no usas Tailscale)" };
        var ayuda = new Label { Text = "La IP de Tailscale está en el panel del servidor, pestaña «Direcciones». Si estás en casa y conectado, el programa la apunta solo.", Left = 14, Top = 170, Width = 412, Height = 44, ForeColor = SystemColors.GrayText };
        var ok = new Button { Text = "Guardar", Left = 246, Top = 226, Width = 86, Height = 30, DialogResult = DialogResult.OK };
        var no = new Button { Text = "Cancelar", Left = 340, Top = 226, Width = 86, Height = 30, DialogResult = DialogResult.Cancel };
        f.Controls.AddRange(new Control[] { nota, l1, casa, l2, fuera, ayuda, ok, no });
        f.AcceptButton = ok; f.CancelButton = no;
        Tema.Aplicar(f);
        if (f.ShowDialog(this) != DialogResult.OK) return;
        string c = LimpiarDireccion(casa.Text), x = LimpiarDireccion(fuera.Text);
        if (c.Length == 0) c = x;
        if (c.Length == 0) return;
        ajustes.Servidor = c;
        ajustes.ServidorExterno = x == c ? "" : x;
        ajustes.Guardar();
        srv = "";
        _ = CargarCanales(true);
        _ = MirarVpn();
    }

    // ---------- favoritos (compartidos con las teles) ----------
    async Task CambiarFavoritoEvento(Evento ev)
    {
        bool poner = !ev.Favorito;
        try
        {
            var envio = new JsonObject { ["id"] = ev.Id, ["inicio"] = new DateTimeOffset(ev.Inicio).ToUnixTimeMilliseconds(), ["titulo"] = ev.Titulo, ["poner"] = poner };
            using var cuerpo = new StringContent(envio.ToJsonString(), Encoding.UTF8, "application/json");
            using var r = await http.PostAsync($"http://{Srv}:8096/api/recordatorio", cuerpo);
            if (r.StatusCode == HttpStatusCode.NotFound) throw new Exception("actualiza el servidor para poder marcar eventos");
            if (!r.IsSuccessStatusCode) throw new Exception($"el servidor ha respondido {(int)r.StatusCode}");
            ev.Favorito = poner;
            Estado(poner ? $"★ {ev.Titulo}: evento favorito (también en las teles)" : $"{ev.Titulo}: quitado de favoritos");
            lista.Invalidate();
        }
        catch (Exception e) { Estado("No se ha podido cambiar el favorito: " + e.Message); }
    }

    async Task CambiarFavorito(Canal? canal = null)
    {
        if (canal == null && lista.SelectedItem is Evento evSel) { await CambiarFavoritoEvento(evSel); return; }
        var c = canal ?? lista.SelectedItem as Canal;
        if (c == null) return;
        if (!agrupado) { Estado("Para marcar favoritos desde aquí hay que actualizar el servidor."); return; }
        bool poner = !c.Favorito;
        try
        {
            var ids = new JsonArray();
            foreach (var e in c.Enlaces) ids.Add(e.Id);
            var envio = new JsonObject { ["ids"] = ids, ["favorito"] = poner };
            using var cuerpo = new StringContent(envio.ToJsonString(), Encoding.UTF8, "application/json");
            using var r = await http.PostAsync($"http://{Srv}:8096/api/favorito", cuerpo);
            if (!r.IsSuccessStatusCode) throw new Exception($"el servidor ha respondido {(int)r.StatusCode}");
            c.Favorito = poner;
            if (actual == null) Estado(poner ? $"★ {c.Titulo}: añadido a favoritos" : $"{c.Titulo}: quitado de favoritos");
            todos = todos.OrderBy(x => x.Raro).ThenBy(x => x.Titulo, StringComparer.CurrentCultureIgnoreCase).ToList();
            Filtrar();
            ComponerInicio();
        }
        catch (Exception e) { Estado("No se ha podido cambiar el favorito: " + e.Message); }
    }

    // ---------- enviar un canal a la tele: usa el mando por red de la APK (tele: Ajustes → Controlar HomeTV desde el móvil) ----------
    sealed record TeleMando(string Nombre, string Direccion, string Clave);

    async Task<List<TeleMando>> TelesConMando()
    {
        var lista = new List<TeleMando>();
        using var doc = JsonDocument.Parse(await http.GetStringAsync($"http://{Srv}:8096/api/estado"));
        if (doc.RootElement.TryGetProperty("teles", out var ts) && ts.ValueKind == JsonValueKind.Array)
            foreach (var t in ts.EnumerateArray())
            {
                string movil = Cadena(t, "movil");
                if (movil.Length == 0 || !Uri.TryCreate(movil, UriKind.Absolute, out var u)) continue;
                string clave = u.AbsolutePath.Trim('/');
                if (clave.Length == 0) continue;
                string nombre = Cadena(t, "nombre");
                lista.Add(new TeleMando(nombre.Length > 0 ? nombre : "Tele", $"{u.Scheme}://{u.Authority}", clave));
            }
        return lista;
    }

    async Task EnviarATele(Canal c)
    {
        if (c.Enlaces.Count == 0) return;
        List<TeleMando> teles;
        try { teles = await TelesConMando(); }
        catch (Exception e) { Estado("No se ha podido preguntar al servidor por las teles: " + e.Message); return; }
        if (teles.Count == 0)
        {
            MessageBox.Show(this, "Ninguna tele tiene activado el mando por red.\n\nEn la tele: Ajustes → «Controlar HomeTV desde el móvil» → encenderlo. Después, esa tele saldrá aquí.", "HomeTV · Enviar a la tele", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        TeleMando? elegida = teles.Count == 1 ? teles[0] : null;
        if (elegida == null)
        {
            var tcs = new TaskCompletionSource<TeleMando?>();
            var m = new ContextMenuStrip { Renderer = new ToolStripProfessionalRenderer(new ColoresOscuros()), ForeColor = Texto };
            foreach (var t in teles)
            {
                var it = new ToolStripMenuItem(t.Nombre) { ForeColor = Texto };
                it.Click += (_, _) => tcs.TrySetResult(t);
                m.Items.Add(it);
            }
            m.Closed += (_, _) => BeginInvoke((Action)(() => tcs.TrySetResult(null)));
            m.Show(Cursor.Position);
            elegida = await tcs.Task;
            if (elegida == null) return;
        }
        try
        {
            var envio = new JsonObject { ["id"] = c.Enlaces[0].Id, ["app"] = "interno" };
            using var peticion = new HttpRequestMessage(HttpMethod.Post, $"{elegida.Direccion}/api/reproducir") { Content = new StringContent(envio.ToJsonString(), Encoding.UTF8, "application/json") };
            peticion.Headers.Add("X-Token", elegida.Clave);
            using var r = await http.SendAsync(peticion);
            if (!r.IsSuccessStatusCode)
                throw new Exception(r.StatusCode == HttpStatusCode.Unauthorized ? "la clave ha cambiado (en la tele, vuelve a encender «Controlar HomeTV desde el móvil»)" : $"la tele ha respondido {(int)r.StatusCode}");
            Estado($"▶ «{c.Titulo}» enviado a {elegida.Nombre}");
        }
        catch (Exception e) { Estado($"No se ha podido enviar a {elegida.Nombre}: {e.Message}"); }
    }

    // ---------- listas: encender o apagar, igual que en la tele (el cambio es para todos los aparatos) ----------
    async Task ElegirListas()
    {
        JsonNode? raiz;
        try { raiz = JsonNode.Parse(await http.GetStringAsync($"http://{Srv}:8096/sincro")); }
        catch (Exception e) { MessageBox.Show(this, "No se ha podido leer las listas del servidor:\n\n" + e.Message, "HomeTV · Listas", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
        var fuentes = raiz?["datos"]?["sources"] as JsonArray;
        var canales = raiz?["datos"]?["channels"] as JsonArray;
        if (fuentes == null || fuentes.Count == 0) { MessageBox.Show(this, "El servidor no tiene listas. Se añaden desde el panel o desde la tele.", "HomeTV · Listas"); return; }
        var cuenta = new Dictionary<string, int>();
        if (canales != null)
            foreach (var c in canales)
                if (c?["listas"] is JsonArray ls)
                    foreach (var l in ls) { string id = l?.ToString() ?? ""; cuenta[id] = cuenta.GetValueOrDefault(id) + 1; }

        using var f = new Form { Text = "Listas de canales", FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterParent, ClientSize = new Size(460, 420), MinimizeBox = false, MaximizeBox = false, Font = Font };
        var nota = new Label { Text = "Marca las listas que quieres ver. El cambio vale para todas las teles, la web y este programa.", Left = 14, Top = 10, Width = 432, Height = 40 };
        var caja = new CheckedListBox { Left = 14, Top = 54, Width = 432, Height = 306, CheckOnClick = true, IntegralHeight = false };
        var ids = new List<string>();
        foreach (var x in fuentes)
        {
            string id = x?["id"]?.ToString() ?? "";
            string nombre = x?["name"]?.ToString() ?? id;
            bool encendida = !(x?["enabled"] is JsonValue v && v.TryGetValue<bool>(out bool en) && !en);
            ids.Add(id);
            caja.Items.Add($"{nombre}   ({cuenta.GetValueOrDefault(id)} canales)", encendida);
        }
        bool quiereAñadir = false;
        var mas = new Button { Text = "Añadir lista…", Left = 14, Top = 374, Width = 120, Height = 32 };
        mas.Click += (_, _) => { quiereAñadir = true; f.DialogResult = DialogResult.Cancel; };
        var ok = new Button { Text = "Guardar", Left = 266, Top = 374, Width = 86, Height = 32, DialogResult = DialogResult.OK };
        var no = new Button { Text = "Cancelar", Left = 360, Top = 374, Width = 86, Height = 32, DialogResult = DialogResult.Cancel };
        f.Controls.AddRange(new Control[] { nota, caja, mas, ok, no });
        f.AcceptButton = ok; f.CancelButton = no;
        Tema.Aplicar(f);
        if (f.ShowDialog(this) != DialogResult.OK) { if (quiereAñadir) await AñadirLista(); return; }

        var quiere = new Dictionary<string, bool>();
        for (int i = 0; i < ids.Count; i++) quiere[ids[i]] = caja.GetItemChecked(i);

        // Se guarda sobre lo último del servidor; si una tele cambió algo justo ahora (409), se repite sobre lo nuevo
        for (int intento = 0; intento < 3; intento++)
        {
            try
            {
                var datos = raiz!["datos"]!;
                int cambios = 0;
                foreach (var x in (JsonArray)datos["sources"]!)
                {
                    string id = x?["id"]?.ToString() ?? "";
                    if (x == null || !quiere.TryGetValue(id, out bool enc)) continue;
                    bool ahora = !(x["enabled"] is JsonValue v && v.TryGetValue<bool>(out bool en) && !en);
                    if (ahora != enc) { x["enabled"] = enc; cambios++; }
                }
                if (cambios == 0) return;
                var envio = new JsonObject { ["base"] = raiz["rev"]?.DeepClone(), ["datos"] = datos.DeepClone(), ["de"] = "Windows" };
                using var cuerpo = new StringContent(envio.ToJsonString(), Encoding.UTF8, "application/json");
                using var resp = await http.PutAsync($"http://{Srv}:8096/sincro", cuerpo);
                string txt = await resp.Content.ReadAsStringAsync();
                if ((int)resp.StatusCode == 409) { raiz = JsonNode.Parse(txt); continue; }
                if (!resp.IsSuccessStatusCode) throw new Exception($"el servidor ha respondido {(int)resp.StatusCode}");
                await CargarCanales(true);
                return;
            }
            catch (Exception e) { MessageBox.Show(this, "No se han podido guardar las listas:\n\n" + e.Message, "HomeTV · Listas", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
        }
        MessageBox.Show(this, "Otra tele está cambiando cosas a la vez. Prueba otra vez en un momento.", "HomeTV · Listas", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    // ---------- añadir una lista: desde una dirección, un archivo o texto pegado ----------
    // El servidor es quien la lee y la guarda (igual que cuando se añade desde la tele), así llega a todos los aparatos.
    async Task AñadirLista(string? archivo = null)
    {
        using var f = new Form { Text = "Añadir una lista de canales", FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterParent, ClientSize = new Size(560, 506), MinimizeBox = false, MaximizeBox = false, Font = Font, BackColor = Fondo, ForeColor = Texto };
        Label Et(string t, int y) => new() { Text = t, Left = 14, Top = y, Width = 530, Height = 20 };
        var nota = new Label { Text = "Admite listas M3U, exportaciones de AceList (.json), archivos de texto con enlaces listas dinámicas de MylinkPaste (pega su código o mylinkpaste://código) y cuentas IPTV con usuario y contraseña (Xtream Codes: pon la dirección del servidor y rellena usuario y contraseña). Puedes arrastrar un archivo a la ventana.", Left = 14, Top = 10, Width = 532, Height = 40, ForeColor = Tenue };
        var nombre = new TextBox { Left = 14, Top = 76, Width = 532, BackColor = Panel1, ForeColor = Texto, BorderStyle = BorderStyle.FixedSingle };
        var url = new TextBox { Left = 14, Top = 130, Width = 532, BackColor = Panel1, ForeColor = Texto, BorderStyle = BorderStyle.FixedSingle, PlaceholderText = "https://…/lista.m3u   ·   mylinkpaste://código   ·   http://servidor:puerto (IPTV)" };
        var usuario = new TextBox { Left = 14, Top = 158, Width = 262, BackColor = Panel1, ForeColor = Texto, BorderStyle = BorderStyle.FixedSingle, PlaceholderText = "Usuario (solo si la lista lo pide)" };
        var clave = new TextBox { Left = 284, Top = 158, Width = 262, BackColor = Panel1, ForeColor = Texto, BorderStyle = BorderStyle.FixedSingle, PlaceholderText = "Contraseña", UseSystemPasswordChar = true };
        using var fConsolas = new Font("Consolas", 9f);
        var texto = new TextBox { Left = 14, Top = 250, Width = 532, Height = 196, Multiline = true, ScrollBars = ScrollBars.Vertical, WordWrap = false, BackColor = Panel1, ForeColor = Texto, BorderStyle = BorderStyle.FixedSingle, AcceptsReturn = true, Font = fConsolas };
        var bArchivo = new Button { Text = "Abrir archivo…", Left = 14, Top = 216, Width = 130, Height = 28, FlatStyle = FlatStyle.Flat, BackColor = Panel2 };
        var bPegar = new Button { Text = "Pegar del portapapeles", Left = 152, Top = 216, Width = 170, Height = 28, FlatStyle = FlatStyle.Flat, BackColor = Panel2 };
        bArchivo.FlatAppearance.BorderSize = 0; bPegar.FlatAppearance.BorderSize = 0;
        var resumen = new Label { Left = 330, Top = 220, Width = 216, Height = 22, ForeColor = Tenue, TextAlign = ContentAlignment.MiddleRight };
        var ok = new Button { Text = "Añadir", Left = 358, Top = 460, Width = 92, Height = 34, FlatStyle = FlatStyle.Flat, BackColor = Acento, ForeColor = Fondo, DialogResult = DialogResult.OK };
        var no = new Button { Text = "Cancelar", Left = 458, Top = 460, Width = 88, Height = 34, FlatStyle = FlatStyle.Flat, BackColor = Panel2, DialogResult = DialogResult.Cancel };
        ok.FlatAppearance.BorderSize = 0; no.FlatAppearance.BorderSize = 0;
        f.Controls.AddRange(new Control[] { nota, Et("Nombre de la lista", 56), nombre, Et("Dirección, código MylinkPaste o servidor IPTV (si la lista está en internet)", 110), url, usuario, clave, Et("…o el contenido: abre un archivo o pega aquí", 196), bArchivo, bPegar, resumen, texto, ok, no });
        f.AcceptButton = null; f.CancelButton = no;

        void PonerArchivo(string ruta)
        {
            try
            {
                var info = new FileInfo(ruta);
                if (info.Length > 40_000_000) { MessageBox.Show(f, "El archivo es demasiado grande para una lista.", "HomeTV"); return; }
                texto.Text = File.ReadAllText(ruta);
                url.Text = "";
                if (nombre.Text.Length == 0) nombre.Text = Path.GetFileNameWithoutExtension(ruta);
            }
            catch (Exception e) { MessageBox.Show(f, "No se ha podido leer el archivo:\n\n" + e.Message, "HomeTV", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        }
        bArchivo.Click += (_, _) =>
        {
            using var d = new OpenFileDialog { Title = "Elige una lista", Filter = "Listas de canales|*.m3u;*.m3u8;*.json;*.txt;*.acelist|Todos los archivos|*.*" };
            if (d.ShowDialog(f) == DialogResult.OK) PonerArchivo(d.FileName);
        };
        bPegar.Click += (_, _) => { if (Clipboard.ContainsText()) { texto.Text = Clipboard.GetText(); url.Text = ""; } };
        texto.TextChanged += (_, _) =>
        {
            int enlaces = texto.Text.Split('\n').Count(l => l.Trim().Length > 0 && !l.TrimStart().StartsWith('#'));
            resumen.Text = texto.TextLength == 0 ? "" : $"{enlaces} líneas con enlaces";
        };
        url.TextChanged += (_, _) =>
        {
            string v = url.Text.Trim();
            if (v.Length == 0 || nombre.Text.Length > 0) return;
            if (v.StartsWith("mylinkpaste://", StringComparison.OrdinalIgnoreCase)) nombre.Text = "MylinkPaste";
            else if (Uri.TryCreate(v, UriKind.Absolute, out var u)) nombre.Text = u.Host;
        };
        f.AllowDrop = true;
        f.DragEnter += (_, e) => { if (e.Data?.GetDataPresent(DataFormats.FileDrop) == true) e.Effect = DragDropEffects.Copy; };
        f.DragDrop += (_, e) => { if (e.Data?.GetData(DataFormats.FileDrop) is string[] a && a.Length > 0) PonerArchivo(a[0]); };
        if (archivo != null && File.Exists(archivo)) PonerArchivo(archivo);
        else if (Clipboard.ContainsText())
        {
            string t = Clipboard.GetText().Trim();
            if ((t.StartsWith("http", StringComparison.OrdinalIgnoreCase) || t.StartsWith("mylinkpaste://", StringComparison.OrdinalIgnoreCase)) && !t.Contains('\n') && t.Length < 400) url.Text = t;
        }

        Tema.Aplicar(f);
        while (true)
        {
            if (f.ShowDialog(this) != DialogResult.OK) return;
            if (url.Text.Trim().Length == 0 && texto.Text.Trim().Length == 0) { MessageBox.Show(this, "Pon una dirección o abre un archivo (o pega el contenido).", "HomeTV"); continue; }
            break;
        }

        Estado("Añadiendo la lista…");
        try
        {
            var envio = new JsonObject { ["nombre"] = nombre.Text.Trim() };
            if (url.Text.Trim().Length > 0) { envio["url"] = url.Text.Trim(); if (usuario.Text.Trim().Length > 0) { envio["usuario"] = usuario.Text.Trim(); envio["clave"] = clave.Text; } } else envio["texto"] = texto.Text;
            using var cuerpo = new StringContent(envio.ToJsonString(), Encoding.UTF8, "application/json");
            using var cancelar = new CancellationTokenSource(TimeSpan.FromSeconds(140));
            using var r = await httpLargo.PostAsync($"http://{Srv}:8096/api/lista", cuerpo, cancelar.Token);
            string txt = await r.Content.ReadAsStringAsync();
            if (r.StatusCode == HttpStatusCode.NotFound) throw new Exception("este servidor todavía no sabe añadir listas: actualízalo desde su panel (botón «Actualizar el servidor»)");
            using var doc = JsonDocument.Parse(txt);
            if (!r.IsSuccessStatusCode) throw new Exception(Cadena(doc.RootElement, "error"));
            var raiz = doc.RootElement;
            int creados = raiz.TryGetProperty("creados", out var c1) ? c1.GetInt32() : 0;
            int repetidos = raiz.TryGetProperty("repetidos", out var c2) ? c2.GetInt32() : 0;
            int malos = raiz.TryGetProperty("invalidos", out var c3) ? c3.GetInt32() : 0;
            await CargarCanales(false);
            string msg = $"Lista «{Cadena(raiz, "fuente")}» añadida: {creados} canales nuevos" + (repetidos > 0 ? $", {repetidos} ya los tenías" : "") + (malos > 0 ? $", {malos} líneas no válidas" : "") + ".";
            Estado(msg);
            MessageBox.Show(this, msg + "\n\nLa verá también la tele y la web. Los canales nuevos aparecen como «sin comprobar» hasta que el servidor los revise.", "HomeTV", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception e)
        {
            Estado("No se ha podido añadir la lista");
            MessageBox.Show(this, "No se ha podido añadir la lista:\n\n" + e.Message, "HomeTV", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    // ---------- VPN (WARP o Proton): la VPN del motor, que vive en el servidor ----------
    // El P2P lo hace el motor del servidor, así que la VPN se pone allí (no en este PC): aquí solo se ve y se cambia.
    string vpnProveedor = "Cloudflare WARP";
    string vpnProveedorId = "warp";   // el que está en uso: warp o proton
    string vpnPais = "";              // país por el que sale ahora
    string vpnCiudad = "";
    string vpnIp = "";
    bool protonListo;
    string[] paisesProton = Array.Empty<string>();   // en orden de preferencia: el primero es el elegido
    string vpnNombre => vpnProveedorId == "proton" ? "Proton" : "WARP";
    static readonly Dictionary<string, string> NombresPais = new()
    {
        ["Spain"] = "España", ["Portugal"] = "Portugal", ["France"] = "Francia", ["Germany"] = "Alemania", ["Netherlands"] = "Países Bajos",
        ["Switzerland"] = "Suiza", ["Italy"] = "Italia", ["United Kingdom"] = "Reino Unido", ["Sweden"] = "Suecia", ["Belgium"] = "Bélgica",
    };
    static string PaisEs(string p) => NombresPais.TryGetValue(p, out var n) ? n : p;

    async Task MirarVpn()
    {
        try
        {
            using var doc = JsonDocument.Parse(await http.GetStringAsync($"http://{Srv}:8096/api/estado"));
            var r = doc.RootElement;
            if (ajustes.ServidorExterno.Length == 0 && r.TryGetProperty("direcciones", out var dirs) && dirs.ValueKind == JsonValueKind.Object
                && dirs.TryGetProperty("tailscale", out var ts) && ts.ValueKind == JsonValueKind.String && (ts.GetString() ?? "").StartsWith("100."))
            {
                ajustes.ServidorExterno = ts.GetString()!;
                ajustes.Guardar();
            }
            vpnActiva = false;
            if (r.TryGetProperty("vpn", out var v))
            {
                vpnActiva = Cierto(v, "activa"); vpnIp = Cadena(v, "ip"); vpnPais = Cadena(v, "pais"); vpnCiudad = Cadena(v, "ciudad");
                string prov = Cadena(v, "proveedor");
                if (prov.Length > 0) vpnProveedor = prov;
                string id = Cadena(v, "proveedorId");
                vpnProveedorId = id.Length > 0 ? id : prov.Contains("Proton") ? "proton" : "warp";
            }
            vpnCambiando = false;
            if (r.TryGetProperty("vpnCambio", out var c))
            {
                vpnCambiando = Cierto(c, "aplicando") || Cadena(c, "pedido").Length > 0;
                protonListo = Cierto(c, "protonListo");
                paisesProton = c.TryGetProperty("paises", out var ps) && ps.ValueKind == JsonValueKind.Array ? ps.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToArray() : Array.Empty<string>();
            }
            // Siempre se ve de un vistazo qué hay: «Sin VPN», «Proton» o «WARP»
            rVpn.Etiqueta = vpnCambiando ? "VPN…" : vpnActiva ? vpnNombre : "Sin VPN";
            rVpn.Encendido = vpnActiva && !vpnCambiando;
            rVpn.Enabled = !vpnCambiando;
            rVpn.Invalidate();
            string donde = string.Join(", ", new[] { vpnCiudad, PaisEs(vpnPais) }.Where(x => x.Length > 0));
            ayudas.SetToolTip(rVpn, vpnCambiando ? "Cambiando la VPN del servidor… tarda unos 30 segundos."
                : vpnActiva ? $"El motor sale por {vpnProveedor}{(donde.Length > 0 ? " · " + donde : "")}{(vpnIp.Length > 0 ? $" ({vpnIp})" : "")}. Pulsa para cambiar de VPN o de país."
                : "El motor sale directamente por tu conexión (sin VPN). Pulsa para elegir una.");
            pieVpn = vpnCambiando ? "VPN: cambiando…" : vpnActiva ? $"VPN: {vpnNombre}{(vpnPais.Length > 0 ? " · " + PaisEs(vpnPais) : "")}" : "Sin VPN";
            ActualizarPie();
            mirarVpn.Interval = vpnCambiando ? 4000 : 20000;
        }
        catch { rVpn.Etiqueta = "VPN ?"; rVpn.Enabled = false; rVpn.Invalidate(); }
    }

    string pieVpn = "";
    string pieBase = "";
    void ActualizarPie() { pie.Text = pieBase + (pieVpn.Length > 0 ? " · " + pieVpn : ""); }

    // Menú de la VPN: elegir ninguna, WARP o Proton (con su país)
    void MenuVpn()
    {
        var m = new ContextMenuStrip { Renderer = new ToolStripProfessionalRenderer(new ColoresOscuros()), ForeColor = Texto };
        string donde = string.Join(", ", new[] { vpnCiudad, PaisEs(vpnPais) }.Where(x => x.Length > 0));
        m.Items.Add(new ToolStripMenuItem(vpnActiva ? $"Ahora: {vpnProveedor}{(donde.Length > 0 ? " · " + donde : "")}" : "Ahora: sin VPN (sale directo)") { Enabled = false });
        m.Items.Add(new ToolStripSeparator());
        var sin = new ToolStripMenuItem("Sin VPN (salir directo)") { Checked = !vpnActiva };
        sin.Click += (_, _) => { if (vpnActiva) _ = EnviarVpn("{\"usar\":\"ninguna\"}"); };
        m.Items.Add(sin);
        var warp = new ToolStripMenuItem("Cloudflare WARP (gratis, siempre sale por España)") { Checked = vpnActiva && vpnProveedorId == "warp" };
        warp.Click += (_, _) => { if (!(vpnActiva && vpnProveedorId == "warp")) _ = EnviarVpn("{\"usar\":\"warp\"}"); };
        m.Items.Add(warp);
        m.Items.Add(new ToolStripSeparator());
        m.Items.Add(new ToolStripMenuItem("Proton VPN · elige país:") { Enabled = false });
        string elegido = paisesProton.Length > 0 ? paisesProton[0] : "Spain";
        foreach (var pais in new[] { "Spain", "Portugal", "France", "Germany", "Netherlands", "Switzerland", "Italy", "United Kingdom" })
        {
            string p = pais;
            var it = new ToolStripMenuItem("      " + PaisEs(p)) { Enabled = protonListo, Checked = vpnActiva && vpnProveedorId == "proton" && elegido == p };
            it.Click += async (_, _) =>
            {
                bool yaProton = vpnActiva && vpnProveedorId == "proton";
                if (!await EnviarVpn($"{{\"pais\":\"{p}\"}}", false)) return;
                if (!yaProton) await EnviarVpn("{\"usar\":\"proton\"}");
            };
            m.Items.Add(it);
        }
        if (!protonListo) m.Items.Add(new ToolStripMenuItem("(para Proton guarda antes su clave en el servidor)") { Enabled = false });
        m.Show(rVpn, new Point(rVpn.Width + 4, 0), ToolStripDropDownDirection.AboveRight);
    }

    async Task<bool> EnviarVpn(string json, bool avisar = true)
    {
        try
        {
            using var cuerpo = new StringContent(json, Encoding.UTF8, "application/json");
            using var resp = await http.PostAsync($"http://{Srv}:8096/api/vpn", cuerpo);
            string txt = await resp.Content.ReadAsStringAsync();
            if (!resp.IsSuccessStatusCode)
            {
                string error = txt;
                try { using var d = JsonDocument.Parse(txt); error = Cadena(d.RootElement, "error"); } catch { /* texto tal cual */ }
                MessageBox.Show(this, "El servidor no ha podido cambiar la VPN:\n\n" + error, "HomeTV · VPN", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            if (avisar)
            {
                Estado("Cambiando la VPN del servidor: el canal se corta unos 30 segundos y vuelve solo");
                rVpn.Etiqueta = "VPN…";
                rVpn.Enabled = false;
                rVpn.Invalidate();
                mirarVpn.Interval = 4000;
            }
            return true;
        }
        catch (Exception e) { MessageBox.Show(this, "No se ha podido hablar con el servidor:\n\n" + e.Message, "HomeTV · VPN", MessageBoxButtons.OK, MessageBoxIcon.Warning); return false; }
    }

    // ---------- actualización del programa ----------
    async Task BuscarVersionNueva()
    {
        try
        {
            string t = (await http.GetStringAsync(URL_VERSION)).Trim();
            if (!Version.TryParse(t, out var v)) return;
            var mia = VersionPropia;
            if (v.CompareTo(new Version(mia.Major, mia.Minor, Math.Max(mia.Build, 0))) <= 0) return;
            versionNueva = v;
            botonActualizar.Text = $"Actualizar a la versión {v}";
            botonActualizar.Visible = true;
            ColocarCabecera();
        }
        catch { /* sin internet o sin versión publicada: se sigue con la que hay */ }
    }

    // Baja solo los archivos del programa (no el reproductor, que no cambia), y un pequeño guion los pone al cerrar
    async Task Actualizarse()
    {
        if (versionNueva == null) return;
        botonActualizar.Enabled = false;
        botonActualizar.Text = "Descargando…";
        try
        {
            string tmp = Path.Combine(Path.GetTempPath(), "hometv-actualizacion");
            if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
            Directory.CreateDirectory(tmp);
            string zip = Path.Combine(Path.GetTempPath(), "hometv-actualizacion.zip");
            await File.WriteAllBytesAsync(zip, await http.GetByteArrayAsync(URL_ACTUALIZACION));
            ZipFile.ExtractToDirectory(zip, tmp, true);
            if (!File.Exists(Path.Combine(tmp, "HomeTV.dll"))) throw new Exception("la descarga no trae el programa");
            string carpeta = AppContext.BaseDirectory.TrimEnd('\\', '/');
            string guion = Path.Combine(Path.GetTempPath(), "hometv-actualizar.cmd");
            int yo = Environment.ProcessId;
            File.WriteAllText(guion,
                "@echo off\r\nchcp 65001 >nul\r\n" +
                ":espera\r\n" +
                $"tasklist /FI \"PID eq {yo}\" 2>nul | find \"{yo}\" >nul && (ping -n 2 127.0.0.1 >nul & goto espera)\r\n" +
                $"xcopy \"{tmp}\\*\" \"{carpeta}\" /y /e /i /q >nul\r\n" +
                $"start \"\" \"{carpeta}\\HomeTV.exe\"\r\n", new UTF8Encoding(false));
            Process.Start(new ProcessStartInfo("cmd.exe", $"/c \"{guion}\"") { CreateNoWindow = true, UseShellExecute = false });
            Close();
        }
        catch (Exception e)
        {
            botonActualizar.Enabled = true;
            botonActualizar.Text = $"Actualizar a la versión {versionNueva}";
            MessageBox.Show(this, "No se ha podido actualizar:\n\n" + e.Message, "HomeTV", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    // ---------- reproducir ----------
    static string motorTexto(string motivo) => motivo;

    // Motor de Ace Stream instalado en este PC (el mismo que lleva la app de la tele); HomeTV no lo trae, hay que tenerlo instalado
    async Task<bool> MotorLocalResponde()
    {
        try
        {
            using var c = new CancellationTokenSource(1500);
            using var r = await http.GetAsync("http://127.0.0.1:6878/webui/api/service?method=get_version&format=json", c.Token);
            return r.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    async Task<bool> HayMotorLocal()
    {
        if (await MotorLocalResponde()) return true;
        string datos = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string? exe = new[]
        {
            Path.Combine(datos, "ACEStream", "engine", "ace_engine.exe"),
            Path.Combine(local, "ACEStream", "engine", "ace_engine.exe"),
            @"C:\Program Files\ACEStream\engine\ace_engine.exe",
            @"C:\Program Files (x86)\ACEStream\engine\ace_engine.exe",
        }.FirstOrDefault(File.Exists);
        if (exe == null) return false;
        try { Process.Start(new ProcessStartInfo(exe, "--client-console") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(exe)! }); }
        catch { return false; }
        for (int i = 0; i < 25; i++) { await Task.Delay(1000); if (await MotorLocalResponde()) return true; }
        return false;
    }

    async Task ProbarMotorLocal()
    {
        bool hay = await HayMotorLocal();
        probandoLocal = false;
        if (actual == null) return;
        if (hay) { motorLocal = true; manifest = false; intentos = 0; Estado($"Abriendo {actual.Titulo} con el motor de este PC…"); }
        else { Estado("No hay motor de Ace Stream instalado en este PC: sigo con los demás enlaces"); intentos = 2; }
        reintento.Interval = 400;
        reintento.Start();
    }

    async Task AbrirTrasMotor(Canal c)
    {
        Estado("Preparando el motor de este PC…");
        bool hay = await HayMotorLocal();
        if (actual != c) return;
        if (!hay) { motorLocal = false; Estado("No hay motor de Ace Stream en este PC: uso el del servidor"); }
        Abrir();
    }

    string UrlDe(Enlace e) => e.Url ?? $"http://{(motorLocal ? "127.0.0.1" : Srv)}:6878/ace/{(manifest ? "manifest.m3u8" : "getstream")}?{(e.Tipo == "infohash" ? "infohash" : "id")}={e.Id}&pid={pid}";

    // Ficha de un evento de la agenda: qué es, cuándo, dónde lo dan, verlo y marcarlo como favorito
    // Enciende una lista del servidor (vale para todas las teles) y recarga los canales
    async Task ActivarLista(string id)
    {
        for (int intento = 0; intento < 3; intento++)
        {
            try
            {
                var raiz = JsonNode.Parse(await http.GetStringAsync($"http://{Srv}:8096/sincro"));
                var datos = raiz!["datos"]!;
                foreach (var x in (JsonArray)datos["sources"]!) if (x?["id"]?.ToString() == id) x["enabled"] = true;
                var envio = new JsonObject { ["base"] = raiz["rev"]?.DeepClone(), ["datos"] = datos.DeepClone(), ["de"] = "Windows" };
                using var cuerpo = new StringContent(envio.ToJsonString(), Encoding.UTF8, "application/json");
                using var resp = await http.PutAsync($"http://{Srv}:8096/sincro", cuerpo);
                if ((int)resp.StatusCode == 409) continue;
                if (!resp.IsSuccessStatusCode) throw new Exception($"el servidor ha respondido {(int)resp.StatusCode}");
                await CargarCanales(true);
                Estado("Lista activada. Ya puedes buscar el canal.");
                return;
            }
            catch (Exception e) { Estado("No se ha podido activar la lista: " + e.Message); return; }
        }
    }

    async Task FichaEvento(Evento ev)
    {
        var canal = CanalDe(ev);
        string dia = ev.Inicio.Date == DateTime.Today ? "hoy" : ev.Inicio.Date == DateTime.Today.AddDays(1) ? "mañana" : ev.Inicio.ToString("dddd d 'de' MMMM");
        string cuando = ev.Aplazado ? "Aplazado" : ev.Vivo ? "En directo ahora" : $"{dia} a las {ev.Inicio:HH:mm}";
        string donde = canal != null ? (ev.Posible ? $"Quizá en «{canal.Titulo}» (la agenda solo dice: {ev.Canales})" : $"Lo tienes en «{canal.Titulo}»") : (ev.Canales.Length > 0 ? $"No tienes canal para verlo. Lo dan en: {ev.Canales}" : "Sin canal anunciado");
        string? youtube = ev.Enlaces.FirstOrDefault(u => u.Contains("youtube.com", StringComparison.OrdinalIgnoreCase) || u.Contains("youtu.be", StringComparison.OrdinalIgnoreCase));
        bool hayExtra = true;
        int filaBotones = hayExtra ? 240 : 196;
        using var f = new Form { Text = "Evento", FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterParent, ClientSize = new Size(460, filaBotones + 54), MinimizeBox = false, MaximizeBox = false, Font = Font, BackColor = Fondo, ForeColor = Texto };
        using var fTitulo = new Font(Font.FontFamily, 13f, FontStyle.Bold);
        var titulo = new Label { Text = ev.Titulo.Replace(" - ", " – "), Left = 16, Top = 14, Width = 428, Height = 54, Font = fTitulo };
        var comp = new Label { Text = $"{ev.Deporte}{(ev.Competicion.Length > 0 ? " · " + ev.Competicion : "")}", Left = 16, Top = 72, Width = 428, Height = 20, ForeColor = Tenue };
        var hora = new Label { Text = cuando, Left = 16, Top = 98, Width = 428, Height = 22, ForeColor = ev.Vivo && !ev.Aplazado ? Directo : Texto };
        var dnd = new Label { Text = donde, Left = 16, Top = 124, Width = 428, Height = 48, ForeColor = canal != null ? Texto : Tenue };
        var ver = new Button { Text = "▶ Ver ahora", Left = 16, Top = filaBotones, Width = 120, Height = 36, FlatStyle = FlatStyle.Flat, BackColor = Acento, ForeColor = Fondo, Enabled = canal != null && !ev.Aplazado };
        var fav = new Button { Text = ev.Favorito ? "★ Favorito (quitar)" : "☆ Marcar favorito", Left = 144, Top = filaBotones, Width = 170, Height = 36, FlatStyle = FlatStyle.Flat, BackColor = Panel2 };
        var cerrar = new Button { Text = "Cerrar", Left = 352, Top = filaBotones, Width = 92, Height = 36, FlatStyle = FlatStyle.Flat, BackColor = Panel2, DialogResult = DialogResult.Cancel };
        ver.FlatAppearance.BorderSize = 0; fav.FlatAppearance.BorderSize = 0; cerrar.FlatAppearance.BorderSize = 0;
        ver.Click += (_, _) => { f.DialogResult = DialogResult.OK; };
        fav.Click += async (_, _) => { fav.Enabled = false; await CambiarFavoritoEvento(ev); fav.Text = ev.Favorito ? "★ Favorito (quitar)" : "☆ Marcar favorito"; fav.Enabled = true; };
        f.Controls.AddRange(new Control[] { titulo, comp, hora, dnd, ver, fav, cerrar });
        // Enlaces directos de la propia agenda (acestream) y la página de YouTube, si el evento las trae
        (string Id, string Etiqueta)? directo = null;
        int izquierda = 16;
        if (ev.Ace.Count > 0)
        {
            var botonAce = new Button { Text = ev.Ace.Count == 1 ? "▶ Enlace directo" : $"▶ Enlaces directos ({ev.Ace.Count})", Left = izquierda, Top = 196, Width = 170, Height = 34, FlatStyle = FlatStyle.Flat, BackColor = Panel2 };
            botonAce.FlatAppearance.BorderSize = 0;
            botonAce.Click += (_, _) =>
            {
                if (ev.Ace.Count == 1) { directo = ev.Ace[0]; f.DialogResult = DialogResult.OK; return; }
                var m = new ContextMenuStrip { Renderer = new ToolStripProfessionalRenderer(new ColoresOscuros()), ForeColor = Texto };
                foreach (var a in ev.Ace)
                {
                    var it = new ToolStripMenuItem(a.Etiqueta.Length > 0 ? a.Etiqueta : (a.Id.Length > 8 ? a.Id[..8] : a.Id)) { ForeColor = Texto };
                    it.Click += (_, _) => { directo = a; f.DialogResult = DialogResult.OK; };
                    m.Items.Add(it);
                }
                m.Show(botonAce, new Point(0, botonAce.Height));
            };
            f.Controls.Add(botonAce);
            izquierda += 178;
        }
        if (youtube != null)
        {
            var botonYt = new Button { Text = "▶ Ver en YouTube", Left = izquierda, Top = 196, Width = 150, Height = 34, FlatStyle = FlatStyle.Flat, BackColor = Panel2 };
            botonYt.FlatAppearance.BorderSize = 0;
            botonYt.Click += (_, _) => { try { Process.Start(new ProcessStartInfo(youtube) { UseShellExecute = true }); } catch (Exception e) { Estado("No se ha podido abrir YouTube: " + e.Message); } };
            f.Controls.Add(botonYt);
            izquierda += 158;
        }
        if (canal == null)
        {
            var botonBus = new Button { Text = "🔍 Buscar en otras listas", Left = izquierda, Top = 196, Width = 190, Height = 34, FlatStyle = FlatStyle.Flat, BackColor = Panel2 };
            botonBus.FlatAppearance.BorderSize = 0;
            botonBus.Click += async (_, _) =>
            {
                botonBus.Enabled = false;
                try
                {
                    var nombres = (ev.Canales.Length > 0 ? ev.Canales : ev.Titulo).Split(new[] { ',', '/', '|', ';' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                    var vistos = new HashSet<string>();
                    var m = new ContextMenuStrip { Renderer = new ToolStripProfessionalRenderer(new ColoresOscuros()), ForeColor = Texto };
                    foreach (var n in nombres.Take(4))
                    {
                        var r = JsonNode.Parse(await http.GetStringAsync($"http://{Srv}:8096/api/buscar-canal?q={Uri.EscapeDataString(n)}"));
                        if (r?["items"] is not JsonArray its) continue;
                        foreach (var it in its)
                        {
                            string idc = it?["id"]?.ToString() ?? "";
                            if (!vistos.Add(idc)) continue;
                            var ls = (it?["listas"] as JsonArray)?.Select(x => (Id: x?["id"]?.ToString() ?? "", Nombre: x?["name"]?.ToString() ?? "")).ToList() ?? new();
                            if (ls.Count == 0) continue;
                            var mi = new ToolStripMenuItem($"{it?["title"]} — activar lista «{ls[0].Nombre}»") { ForeColor = Texto };
                            string lid = ls[0].Id;
                            mi.Click += async (_, _) => { f.DialogResult = DialogResult.Cancel; await ActivarLista(lid); };
                            m.Items.Add(mi);
                            if (m.Items.Count >= 12) break;
                        }
                    }
                    if (m.Items.Count == 0) { MessageBox.Show(f, "No hay nada parecido en el resto de listas del servidor.", "HomeTV · Buscar"); }
                    else m.Show(botonBus, new Point(0, botonBus.Height));
                }
                catch (Exception e) { MessageBox.Show(f, "No se ha podido buscar: " + e.Message, "HomeTV · Buscar", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
                botonBus.Enabled = true;
            };
            f.Controls.Add(botonBus);
        }
        if (canal != null && !ev.Aplazado && ev.Inicio.AddHours(2) > DateTime.Now)
        {
            bool otraFila = izquierda + 190 > 444;
            if (otraFila) { foreach (var b in new[] { ver, fav, cerrar }) b.Top += 40; f.ClientSize = new Size(f.ClientSize.Width, f.ClientSize.Height + 40); }
            var botonGrab = new Button { Text = ev.Inicio > DateTime.Now ? "⏺ Programar grabación" : "⏺ Grabar desde ahora", Left = otraFila ? 16 : izquierda, Top = otraFila ? 236 : 196, Width = 190, Height = 34, FlatStyle = FlatStyle.Flat, BackColor = Panel2 };
            botonGrab.FlatAppearance.BorderSize = 0;
            botonGrab.Click += async (_, _) => { botonGrab.Enabled = false; if (await Grabar(ev.Titulo, canal, ev.Inicio, 0, ev.Deporte)) botonGrab.Text = "✓ Grabación pedida"; else botonGrab.Enabled = true; };
            f.Controls.Add(botonGrab);
        }
        f.CancelButton = cerrar;
        Tema.Aplicar(f);
        if (f.ShowDialog(this) == DialogResult.OK)
        {
            if (directo is { } d)
            {
                // Un canal suelto con el enlace de la agenda: se abre como cualquier otro, sin buscarlo entre mis listas
                var suelto = new Canal { Clave = "agenda-" + d.Id, Titulo = d.Etiqueta.Length > 0 ? d.Etiqueta : ev.Titulo };
                suelto.Enlaces.Add(new Enlace { Id = d.Id, Titulo = suelto.Titulo });
                Poner(suelto);
            }
            else if (canal != null) Poner(canal);
        }
        await Task.CompletedTask;
    }

    void ReproducirSeleccionado()
    {
        if (lista.SelectedItem is Canal c) { Poner(c); return; }
        if (lista.SelectedItem is Evento ev)
        {
            var canal = CanalDe(ev);
            if (canal != null) Poner(canal);
            else Estado(ev.Canales.Length > 0 ? $"No tienes canal para este partido (lo dan en {ev.Canales})" : "Este partido aún no tiene canal");
        }
    }

    void Poner(Canal c, int cual = 0)
    {
        viaAac = false; pistasProbadas = 0;
        if (IsHandleCreated) BeginInvoke(new Action(() => { ficha.Invalidate(); PonerBotonesFicha(); }));
        actual = c;
        enlace = Math.Clamp(cual, 0, Math.Max(0, c.Enlaces.Count - 1));
        intentos = 0;
        enlacesProbados = 0;
        colchon = ajustes.Colchon;
        manifest = false;
        probadoLocal = false;
        motorLocal = ajustes.MotorLocal == "pc" || (ajustes.MotorLocal == "auto" && sinServidor);
        parones.Clear();
        ajustes.UltimoCanal = c.Clave;
        IrAlVideo();
        if (motorLocal && c.Enlaces.Any(x => x.Url == null)) _ = AbrirTrasMotor(c);
        else Abrir();
    }

    void Abrir()
    {
        reintento.Stop();
        if (actual == null || actual.Enlaces.Count == 0) return;
        if (enlace >= actual.Enlaces.Count) enlace = 0;
        var e = actual.Enlaces[enlace];
        string cual = actual.Enlaces.Count > 1 ? $"  (enlace {enlace + 1} de {actual.Enlaces.Count})" : "";
        Estado(intentos > 0 ? $"Reconectando con {actual.Titulo}…{cual}" : $"Abriendo {actual.Titulo}…{cual}");
        abiertoEn = DateTime.Now;
        sonandoDesde = DateTime.MinValue;
        ultimoTiempo = -1;
        haAvanzado = false;
        enParon = false;
        lista.Invalidate();
        revisarAudioEn = DateTime.MaxValue;
        if (viaAac && e.Url == null) { _ = AbrirAac(e); return; }
        try
        {
            using var media = new Media(vlc, new Uri(UrlDe(e)));
            media.AddOption($":network-caching={colchon}");
            media.AddOption($":live-caching={colchon}");
            media.AddOption(":http-reconnect");
            reproductor.Play(media);
            reproductor.Volume = volumen.Value;
        }
        catch (Exception ex) { Estado($"No se puede abrir {actual.Titulo}: {ex.Message}"); }
    }

    // El enlace se ha cortado o no abre: un par de reintentos y, si no vuelve, se pasa solo al siguiente enlace del canal
    void Corte(string motivo)
    {
        if (actual == null || reintento.Enabled || probandoLocal) return;
        bool funcionaba = sonandoDesde != DateTime.MinValue && (DateTime.Now - sonandoDesde).TotalSeconds > 60;
        if (funcionaba) { intentos = 0; enlacesProbados = 0; }
        sonandoDesde = DateTime.MinValue;
        abiertoEn = DateTime.MinValue;
        intentos++;
        if (intentos > 2 && !manifest && actual.Enlaces[enlace].Url == null)
        {
            // Antes de dejar el enlace: el mismo, pero como lista HLS del motor, que aguanta mejor los baches
            manifest = true;
            intentos = 0;
            Estado($"{motivo}: probando otro modo de lectura de {actual.Titulo}…");
            reintento.Interval = 600;
            reintento.Start();
            return;
        }
        if (intentos > 2 && !probadoLocal && !motorLocal && ajustes.MotorLocal != "servidor" && actual.Enlaces[enlace].Url == null)
        {
            // El servidor no consigue abrirlo: se prueba con el motor de Ace Stream de este PC (si lo hay)
            probadoLocal = true;
            probandoLocal = true;
            Estado($"{motorTexto(motivo)}: probando con el motor de este PC…");
            _ = ProbarMotorLocal();
            return;
        }
        if (intentos > 2)
        {
            manifest = false;
            enlacesProbados++;
            if (enlacesProbados >= actual.Enlaces.Count)
            {
                Estado(actual.Enlaces.Count > 1 ? $"{motivo}: ninguno de los {actual.Enlaces.Count} enlaces de {actual.Titulo} funciona ahora. Prueba otro canal."
                    : $"{motivo}: {actual.Titulo} no funciona ahora. Prueba otro canal.");
                return;
            }
            enlace = (enlace + 1) % actual.Enlaces.Count;
            intentos = 0;
            Estado($"{motivo}: probando el enlace {enlace + 1} de {actual.Enlaces.Count} de {actual.Titulo}…");
            reintento.Interval = 800;
        }
        else
        {
            Estado($"{motivo}: reconectando con {actual.Titulo}…  (intento {intentos})");
            reintento.Interval = intentos == 1 ? 500 : 1500;
        }
        reintento.Start();
    }

    // Si la imagen se queda sin datos una y otra vez, se amplía el colchón (el vídeo llega algo más tarde, pero sin cortes)
    void NotarParon()
    {
        var ahora = DateTime.Now;
        parones.RemoveAll(t => (ahora - t).TotalSeconds > 120);
        parones.Add(ahora);
        if (parones.Count < 3 || colchon >= 20000 || (ahora - ultimoAmpliado).TotalSeconds < 45) return;
        colchon = Math.Min(20000, colchon + 4000);
        ultimoAmpliado = ahora;
        parones.Clear();
        Estado($"La conexión va a trompicones: amplío el colchón a {colchon / 1000} s…");
        reintento.Interval = 300;
        reintento.Start();
    }

    // VLC no siempre avisa cuando el motor deja de mandar datos: si la imagen no avanza, se trata como un corte
    void Vigilar()
    {
        if (actual == null || reintento.Enabled) return;
        if (DateTime.Now >= revisarAudioEn) { revisarAudioEn = DateTime.MaxValue; RevisarAudio(); }
        if (sonandoDesde == DateTime.MinValue)
        {
            if (abiertoEn != DateTime.MinValue && (DateTime.Now - abiertoEn).TotalSeconds > 45) Corte("No arranca");
            return;
        }
        long t;
        try { t = reproductor.Time; } catch { return; }
        if (t != ultimoTiempo)
        {
            if (ultimoTiempo >= 0) haAvanzado = true;
            ultimoTiempo = t;
            ultimoAvance = DateTime.Now;
            return;
        }
        if (haAvanzado && (DateTime.Now - ultimoAvance).TotalSeconds > 15) Corte("Se ha quedado parado");
    }

    void OtroEnlace()
    {
        if (actual == null) return;
        if (actual.Enlaces.Count < 2) { Estado($"{actual.Titulo} solo tiene un enlace"); return; }
        enlace = (enlace + 1) % actual.Enlaces.Count;
        viaAac = false; pistasProbadas = 0;
        intentos = 0;
        enlacesProbados = 0;
        manifest = false;
        Abrir();
    }

    void Parar()
    {
        reintento.Stop();
        actual = null;
        abiertoEn = DateTime.MinValue;
        sonandoDesde = DateTime.MinValue;
        // Stop puede tardar si VLC está esperando a la red: fuera del hilo de la ventana
        Task.Run(() => { try { reproductor.Stop(); } catch { /* ya parado */ } });
        Estado("Parado");
        lista.Invalidate();
    }

    void Zapear(int paso)
    {
        if (vistaCanales.Count == 0) return;
        int i = actual != null ? vistaCanales.FindIndex(c => c.Clave == actual.Clave) : -1;
        i = i < 0 ? 0 : (i + paso + vistaCanales.Count) % vistaCanales.Count;
        Poner(vistaCanales[i]);
        if (!enAgenda) { int j = lista.Items.IndexOf(vistaCanales[i]); if (j >= 0) lista.SelectedIndex = j; }
        if (completa) EnsenarBarra();
    }

    // ---------- pantalla completa ----------
    void EnsenarBarra()
    {
        if (cursorOculto) { Cursor.Show(); cursorOculto = false; }
        barra.Visible = true;
        ocultarBarra.Stop();
        ocultarBarra.Start();
    }

    // Esconde o enseña la lista de canales de la izquierda (se recuerda para la próxima vez)
    void AlternarLista() { if (EsVideo) PonerLista(!lateral.Visible); }
    void Ampliar(bool poner)
    {
        if (poner && !EsVideo) { if (actual == null) return; IrAlVideo(); }
        ampliado = poner;
        ColocarLateral();
        ActualizarRiel();
    }

    // ---------- grabaciones (las hace el servidor, aunque este PC esté apagado) ----------
    void AbrirWeb(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch (Exception e) { Estado("No se ha podido abrir el navegador: " + e.Message); }
    }

    async Task<bool> Grabar(string titulo, Canal canal, DateTime? inicio, int minutos, string deporte = "")
    {
        var enlaces = new JsonArray();
        foreach (var e in canal.Enlaces.Take(6)) enlaces.Add(e.Url != null ? new JsonObject { ["url"] = e.Url } : new JsonObject { ["id"] = e.Id, ["tipo"] = e.Tipo });
        var cuerpo = new JsonObject { ["titulo"] = titulo, ["canal"] = canal.Titulo, ["enlaces"] = enlaces, ["deporte"] = deporte, ["de"] = "Windows" };
        if (inicio is { } i) cuerpo["inicio"] = new DateTimeOffset(i).ToUnixTimeMilliseconds();
        if (minutos > 0) cuerpo["minutos"] = minutos;
        try
        {
            using var c = new StringContent(cuerpo.ToJsonString(), Encoding.UTF8, "application/json");
            using var r = await http.PostAsync($"http://{Srv}:8096/api/grabar", c);
            var d = JsonNode.Parse(await r.Content.ReadAsStringAsync());
            if (!r.IsSuccessStatusCode) throw new Exception(d?["error"]?.ToString() ?? $"el servidor ha respondido {(int)r.StatusCode}");
            Estado(d?["estado"]?.ToString() == "grabando" ? $"⏺ Grabando «{titulo}» en el servidor" : $"⏺ Grabación programada: {titulo}");
            return true;
        }
        catch (Exception e) { Estado("No se ha podido grabar: " + e.Message); MessageBox.Show(this, "No se ha podido grabar:\n\n" + e.Message, "HomeTV · Grabar", MessageBoxButtons.OK, MessageBoxIcon.Warning); return false; }
    }

    void MenuGrabarCanal(Control donde)
    {
        var c = CanalFicha();
        if (c == null) return;
        var m = new ContextMenuStrip { Renderer = new ToolStripProfessionalRenderer(new ColoresOscuros()), ForeColor = Texto };
        foreach (var (t, min) in new[] { ("Grabar 30 minutos", 30), ("Grabar 1 hora", 60), ("Grabar 2 horas", 120), ("Grabar 3 horas", 180) })
        {
            int mm = min;
            var it = new ToolStripMenuItem(t) { ForeColor = Texto };
            it.Click += async (_, _) => await Grabar(c.Ahora is { Length: > 0 } a ? $"{c.Titulo} - {a}" : c.Titulo, c, null, mm);
            m.Items.Add(it);
        }
        m.Items.Add(new ToolStripSeparator());
        var ver = new ToolStripMenuItem("Ver las grabaciones…") { ForeColor = Texto };
        ver.Click += (_, _) => AbrirWeb($"http://{Srv}:8096/#grabaciones");
        m.Items.Add(ver);
        m.Closed += (_, _) => BeginInvoke(new Action(m.Dispose));
        m.Show(donde, new Point(0, -m.PreferredSize.Height));
    }

    // ---------- sonido ----------
    void MenuAudio()
    {
        var m = new ContextMenuStrip { Renderer = new ToolStripProfessionalRenderer(new ColoresOscuros()), ForeColor = Texto };
        try
        {
            var pistas = reproductor.AudioTrackDescription.Where(p => p.Id >= 0).ToList();
            int act = reproductor.AudioTrack;
            if (pistas.Count == 0) m.Items.Add(new ToolStripMenuItem("Este canal no trae pistas de sonido") { Enabled = false, ForeColor = Tenue });
            foreach (var p in pistas)
            {
                int id = p.Id;
                var it = new ToolStripMenuItem(string.IsNullOrWhiteSpace(p.Name) ? $"Pista {id}" : p.Name) { Checked = id == act, ForeColor = Texto };
                it.Click += (_, _) => { reproductor.SetAudioTrack(id); Estado($"Sonido: {it.Text}"); };
                m.Items.Add(it);
            }
        }
        catch { /* sin reproducción */ }
        m.Items.Add(new ToolStripSeparator());
        var aac = new ToolStripMenuItem(viaAac ? "✓ El sonido pasa por el servidor" : "No se oye: pasar el sonido por el servidor") { ForeColor = Texto, Enabled = actual != null && actual.Enlaces.Count > enlace && actual.Enlaces[enlace].Url == null };
        aac.Click += (_, _) => { viaAac = !viaAac; Abrir(); };
        m.Items.Add(aac);
        m.Closed += (_, _) => BeginInvoke(new Action(m.Dispose));
        m.Show(bAudio, new Point(0, -m.PreferredSize.Height));
    }

    // A los pocos segundos de sonar: si hay imagen pero ningún sonido decodificado, se prueba otra pista
    // y, si no hay más, se pasa el canal por el servidor, que convierte el sonido a AAC (AC3, E-AC3, LATM raros…)
    void RevisarAudio()
    {
        try
        {
            if (actual == null) return;
            var pistas = reproductor.AudioTrackDescription.Where(p => p.Id >= 0).ToList();
            if (pistas.Count == 0) return;
            if (reproductor.AudioTrack < 0) { reproductor.SetAudioTrack(pistas[0].Id); revisarAudioEn = DateTime.Now.AddSeconds(5); return; }
            var m = reproductor.Media;
            if (m == null) return;
            var st = m.Statistics;
            if (st.DecodedVideo < 20 || st.DecodedAudio > 0) return;
            if (pistasProbadas + 1 < pistas.Count)
            {
                pistasProbadas++;
                int i = pistas.FindIndex(p => p.Id == reproductor.AudioTrack);
                var sig = pistas[(i + 1) % pistas.Count];
                reproductor.SetAudioTrack(sig.Id);
                Estado($"Sin sonido: probando la pista «{sig.Name}»…");
                revisarAudioEn = DateTime.Now.AddSeconds(5);
                return;
            }
            if (!viaAac && actual.Enlaces[enlace].Url == null)
            {
                viaAac = true;
                Estado($"{actual.Titulo} no se oye aquí: pasando el sonido por el servidor…");
                Abrir();
            }
        }
        catch { /* sin estadísticas: no se toca nada */ }
    }

    async Task AbrirAac(Enlace e)
    {
        try
        {
            var r = JsonNode.Parse(await httpLargo.GetStringAsync($"http://{Srv}:8096/aac/abrir?id={e.Id}&kind={(e.Tipo == "infohash" ? "infohash" : "content_id")}"));
            string? l = r?["lista"]?.ToString();
            if (string.IsNullOrEmpty(l)) throw new Exception(r?["error"]?.ToString() ?? "el servidor no responde");
            if (actual == null || !viaAac) return;
            using var media = new Media(vlc, new Uri($"http://{Srv}:8096{l}"));
            media.AddOption($":network-caching={colchon}");
            media.AddOption(":http-reconnect");
            reproductor.Play(media);
            reproductor.Volume = volumen.Value;
        }
        catch (Exception ex) { viaAac = false; Estado("No se ha podido pasar el sonido por el servidor: " + ex.Message); }
    }

    void PonerLista(bool enseñar)
    {
        ampliado = false;
        ajustes.ListaOculta = !enseñar;
        ajustes.Guardar();
        soloVideo = false;
        listaForzada = false;
        ColocarLateral();
        ActualizarRiel();
        if (enseñar && lateral.Visible) lista.Focus();
    }

    void PantallaCompleta(bool poner)
    {
        if (poner == completa) return;
        if (poner && !EsVideo) { if (actual == null) return; IrAlVideo(); }
        completa = poner;
        if (poner)
        {
            estadoAntes = WindowState;
            limitesAntes = Bounds;
            lateral.Visible = false;
            ficha.Visible = false;
            riel.Visible = false;
            cabecera.Visible = false;
            WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.None;
            Bounds = Screen.FromControl(this).Bounds;
            TopMost = true;
            EnsenarBarra();
        }
        else
        {
            ocultarBarra.Stop();
            if (cursorOculto) { Cursor.Show(); cursorOculto = false; }
            TopMost = false;
            FormBorderStyle = FormBorderStyle.Sizable;
            Bounds = limitesAntes;
            WindowState = estadoAntes;
            ColocarLateral();
            riel.Visible = true;
            cabecera.Visible = true;
            barra.Visible = true;
            lista.Focus();
        }
    }

    // ---------- teclado ----------
    protected override bool ProcessCmdKey(ref Message msg, Keys tecla)
    {
        if (tecla == (Keys.Control | Keys.B) || tecla == (Keys.Control | Keys.F)) { if (completa) PantallaCompleta(false); if (ajustes.ListaOculta && EsVideo) { listaForzada = true; ColocarLateral(); ActualizarRiel(); } buscar.Focus(); buscar.SelectAll(); return true; }
        if (tecla == (Keys.Control | Keys.D)) { _ = CambiarFavorito(seccion == Seccion.Hoy ? heroCanal : null); return true; }
        if (tecla == Keys.F11) { PantallaCompleta(!completa); return true; }
        if (buscar.Focused)
        {
            // Escribiendo: solo Intro / ↓ (ir a la lista) y Esc (borrar)
            if (tecla == Keys.Enter) { lista.Focus(); ReproducirSeleccionado(); return true; }
            if (tecla == Keys.Down) { lista.Focus(); return true; }
            if (tecla == Keys.Escape) { buscar.Clear(); lista.Focus(); return true; }
            return base.ProcessCmdKey(ref msg, tecla);
        }
        switch (tecla)
        {
            case Keys.Escape: if (completa) { PantallaCompleta(false); return true; } break;
            case Keys.F: PantallaCompleta(!completa); return true;
            case Keys.L: if (!completa && EsVideo) { AlternarLista(); return true; } break;
            case Keys.G: if (!completa) { Ir(seccion == Seccion.Hoy ? Seccion.Canales : Seccion.Hoy); return true; } break;
            case Keys.Enter:
                if (!completa) { if (seccion == Seccion.Hoy) { if (heroCanal != null) Poner(heroCanal); } else if (EsVideo) ReproducirSeleccionado(); }
                return true;
            case Keys.H: if (!completa) { Ir(seccion == Seccion.Hoy ? Seccion.Canales : Seccion.Hoy); return true; } break;
            case Keys.E: OtroEnlace(); return true;
            case Keys.A: if (!completa) { Ir(Seccion.Hoy); return true; } break;
                case Keys.Z: if (!completa && EsVideo) { Ampliar(!ampliado); return true; } break;
            case Keys.M: reproductor.Mute = !reproductor.Mute; Estado(reproductor.Mute ? "Silenciado" : TextoSonando()); return true;
            case Keys.Space: if (actual != null) Parar(); else if (EsVideo) ReproducirSeleccionado(); return true;
            case Keys.Up: if (completa) { Zapear(-1); return true; } break;
            case Keys.Down: if (completa) { Zapear(1); return true; } break;
            case Keys.Right: if (completa || !lista.Focused) { volumen.Value = Math.Min(100, volumen.Value + 5); return true; } break;
            case Keys.Left: if (completa || !lista.Focused) { volumen.Value = Math.Max(0, volumen.Value - 5); return true; } break;
        }
        return base.ProcessCmdKey(ref msg, tecla);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            foreach (var t in new[] { reintento, ocultarBarra, vigia, refresco, mirarVpn, reloj }) t.Dispose();
            http.Dispose(); httpLargo.Dispose(); pequenaFuente?.Dispose();
            try { reproductor.Dispose(); vlc.Dispose(); } catch { /* cerrando */ }
        }
        base.Dispose(disposing);
    }
}
