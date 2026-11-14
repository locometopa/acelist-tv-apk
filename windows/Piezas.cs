// Piezas de dibujo propias de la ventana: colores, botón del menú lateral, tarjeta de partido y menús oscuros.
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace HomeTV;

static class Tema
{
    public static readonly Color Fondo = Color.FromArgb(32, 32, 32);
    public static readonly Color Principal = Color.FromArgb(39, 39, 39);
    public static readonly Color Panel1 = Color.FromArgb(45, 45, 45);
    public static readonly Color Panel2 = Color.FromArgb(58, 58, 58);
    public static readonly Color Linea = Color.FromArgb(66, 66, 66);
    public static readonly Color Texto = Color.FromArgb(244, 244, 244);
    public static readonly Color Tenue = Color.FromArgb(160, 160, 160);
    public static readonly Color Acento = Color.FromArgb(198, 242, 78);
    public static readonly Color Directo = Color.FromArgb(255, 122, 122);

    public static readonly Font Normal = new("Segoe UI", 10f);
    public static readonly Font Pequena = new("Segoe UI", 8.5f);
    public static readonly Font Negrita = new("Segoe UI Semibold", 11.5f);
    public static readonly Font Seccion = new("Segoe UI Semibold", 14f);
    public static readonly Font Grande = new("Segoe UI Semibold", 22f);
    public static readonly Font Iconos = new("Segoe MDL2 Assets", 15f);
    public static readonly Font Titanico = new("Segoe UI", 44f);
    public static readonly Font IconosPeq = new("Segoe MDL2 Assets", 10f);

    // Ventanas de diálogo con el mismo aspecto oscuro que la ventana principal (barra de título, fondo, botones, cajas de texto y listas).
    // Solo cambia lo que está con el aspecto por defecto de Windows: lo que ya tiene color propio se queda como está.
    public static void Aplicar(Form f)
    {
        f.BackColor = Fondo;
        f.ForeColor = Texto;
        if (f.IsHandleCreated) Nativo.BarraOscura(f.Handle);
        else f.HandleCreated += (_, _) => Nativo.BarraOscura(f.Handle);
        Pintar(f);
        Nativo.Oscurecer(f);
    }

    static void Pintar(Control padre)
    {
        foreach (Control c in padre.Controls)
        {
            switch (c)
            {
                case Button b:
                    b.FlatStyle = FlatStyle.Flat;
                    b.FlatAppearance.BorderSize = 0;
                    if (b.BackColor == Control.DefaultBackColor) b.BackColor = Panel2;
                    if (b.ForeColor == Control.DefaultForeColor) b.ForeColor = Texto;
                    break;
                case TextBox t:
                    t.BorderStyle = BorderStyle.FixedSingle;
                    t.BackColor = Panel1;
                    t.ForeColor = Texto;
                    break;
                case ListBox l:   // también CheckedListBox
                    l.BorderStyle = BorderStyle.None;
                    l.BackColor = Panel1;
                    l.ForeColor = Texto;
                    break;
                case Label lb:
                    if (lb.ForeColor == Control.DefaultForeColor || lb.ForeColor == SystemColors.GrayText)
                        lb.ForeColor = lb.ForeColor == SystemColors.GrayText ? Tenue : Texto;
                    break;
                case CheckBox or RadioButton:
                    c.ForeColor = Texto;
                    break;
            }
            if (c.HasChildren) Pintar(c);
        }
    }

    public static GraphicsPath Redondeado(Rectangle r, int radio)
    {
        int d = radio * 2;
        var p = new GraphicsPath();
        p.AddArc(r.Left, r.Top, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Top, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}

static class Nativo
{
    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
    static extern int SetWindowTheme(IntPtr ventana, string? tema, string? lista);

    // Barras de desplazamiento oscuras en listas, cajas de texto y paneles con scroll (no se ven barras blancas)
    public static void Oscurecer(Control c)
    {
        if (c is ComboBox)
        {
            void Combo() { try { SetWindowTheme(c.Handle, "DarkMode_CFD", null); } catch { /* sin uxtheme */ } }
            if (c.IsHandleCreated) Combo(); else c.HandleCreated += (_, _) => Combo();
        }
        void Poner() { try { SetWindowTheme(c.Handle, "DarkMode_Explorer", null); } catch { /* sin uxtheme */ } }
        if (c is ListBox or TextBox or ScrollableControl or ListView or TreeView)
        {
            if (c.IsHandleCreated) Poner(); else c.HandleCreated += (_, _) => Poner();
        }
        foreach (Control h in c.Controls) Oscurecer(h);
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr ventana, int atributo, ref int valor, int tamano);

    // Barra de título oscura (Windows 10 2004 y 11); si no se puede, se queda la clara
    public static void BarraOscura(IntPtr ventana)
    {
        try
        {
            int uno = 1;
            if (DwmSetWindowAttribute(ventana, 20, ref uno, 4) != 0) DwmSetWindowAttribute(ventana, 19, ref uno, 4);
        }
        catch { /* sin dwmapi */ }
    }
}

// Botón del menú lateral: un icono de Windows y su nombre debajo
sealed class BotonRiel : Control
{
    public string Glifo;
    public string Etiqueta;
    public bool Activo;      // la sección en la que estoy
    public bool Encendido;   // por ejemplo, WARP puesto
    bool encima;

    public BotonRiel(string glifo, string etiqueta)
    {
        Glifo = glifo;
        Etiqueta = etiqueta;
        Size = new Size(44, 44);
        Cursor = Cursors.Hand;
        TabStop = false;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }

    protected override void OnMouseEnter(EventArgs e) { encima = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { encima = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Parent?.BackColor ?? Tema.Fondo);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        if (Activo || (encima && Enabled))
        {
            using var forma = Tema.Redondeado(new Rectangle(0, 0, Width - 1, Height - 1), 6);
            using var pincel = new SolidBrush(Activo ? Tema.Panel1 : Color.FromArgb(40, 40, 40));
            g.FillPath(pincel, forma);
        }
        if (Activo) { using var a = new SolidBrush(Tema.Acento); g.FillRectangle(a, 0, Height / 2 - 9, 3, 18); }
        Color color = !Enabled ? Color.FromArgb(100, 100, 100) : Encendido ? Tema.Acento : Activo ? Tema.Texto : Tema.Tenue;
        const TextFormatFlags centro = TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix;
        // Solo el icono (el nombre sale al pasar el ratón): el menú es estrecho y no se mueve
        TextRenderer.DrawText(g, Glifo, Tema.Iconos, new Rectangle(0, 0, Width, Height), color, centro);
    }
}

// Tarjeta de un partido: competición y hora arriba, los dos equipos y el canal por el que se ve
sealed class Tarjeta : Control
{
    public readonly Evento Ev;
    public readonly Canal Donde;
    public bool Compacta;     // destacados de Hoy: más baja, el partido en una línea
    bool encima;

    public Tarjeta(Evento ev, Canal donde)
    {
        Ev = ev;
        Donde = donde;
        Height = 176;
        Cursor = Cursors.Hand;
        TabStop = false;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
    }

    protected override void OnMouseEnter(EventArgs e) { encima = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { encima = false; Invalidate(); base.OnMouseLeave(e); }

    static string[] Equipos(string titulo)
    {
        var p = titulo.Split(new[] { " - ", " – ", " vs ", " v " }, 2, StringSplitOptions.None);
        return p.Length == 2 && p[0].Trim().Length > 0 && p[1].Trim().Length > 0 ? new[] { p[0].Trim(), p[1].Trim() } : new[] { titulo };
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Parent?.BackColor ?? Tema.Principal);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new Rectangle(0, 0, Width - 1, Height - 1);
        using var forma = Tema.Redondeado(r, 8);
        using (var b = new SolidBrush(Tema.Panel1)) g.FillPath(b, forma);
        if (Compacta) { PintarCompacta(g, forma); return; }
        var estadoGrafico = g.Save();
        g.SetClip(forma, CombineMode.Intersect);
        using (var b = new SolidBrush(Color.FromArgb(38, 38, 38))) g.FillRectangle(b, 0, 0, Width, 58);
        using (var l = new Pen(Tema.Linea)) g.DrawLine(l, 0, 58, Width, 58);
        g.Restore(estadoGrafico);
        using (var borde = new Pen(encima ? Tema.Acento : Tema.Linea)) g.DrawPath(borde, forma);

        const TextFormatFlags corta = TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding | TextFormatFlags.VerticalCenter;
        bool vivo = !Ev.Aplazado && Ev.Inicio <= DateTime.Now;
        string dia = Ev.Inicio.Date == DateTime.Today ? "" : Ev.Inicio.Date == DateTime.Today.AddDays(1) ? "Mañana " : Ev.Inicio.ToString("ddd ");
        string cuando = Ev.Aplazado ? "APLAZADO" : vivo ? "EN DIRECTO" : dia + Ev.Inicio.ToString("HH:mm");
        var tam = TextRenderer.MeasureText(g, cuando, Tema.Pequena, new Size(1000, 30), TextFormatFlags.NoPadding);
        var insignia = new Rectangle(Width - tam.Width - 30, 17, tam.Width + 16, 24);
        using (var forma2 = Tema.Redondeado(insignia, 4))
        using (var b = new SolidBrush(vivo ? Color.FromArgb(68, 39, 38) : Tema.Panel2)) g.FillPath(b, forma2);
        TextRenderer.DrawText(g, cuando, Tema.Pequena, insignia, vivo ? Tema.Directo : Tema.Texto, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        string comp = Ev.Competicion.Length > 0 ? Ev.Competicion : Ev.Deporte;
        TextRenderer.DrawText(g, comp, Tema.Pequena, new Rectangle(14, 17, Math.Max(10, insignia.Left - 22), 24), Tema.Tenue, corta);

        var eq = Equipos(Ev.Titulo);
        if (eq.Length == 2)
        {
            TextRenderer.DrawText(g, eq[0], Tema.Negrita, new Rectangle(14, 68, Width - 28, 26), Tema.Texto, corta);
            TextRenderer.DrawText(g, eq[1], Tema.Negrita, new Rectangle(14, 94, Width - 28, 26), Tema.Texto, corta);
        }
        else
            TextRenderer.DrawText(g, eq[0], Tema.Negrita, new Rectangle(14, 68, Width - 28, 52), Tema.Texto, TextFormatFlags.WordBreak | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding);

        string donde = Donde.Titulo + (Donde.Enlaces.Count > 1 ? $" · {Donde.Enlaces.Count} enlaces" : "");
        TextRenderer.DrawText(g, donde, Tema.Pequena, new Rectangle(14, Height - 36, Width - 28, 22), Tema.Tenue, corta);
    }

    void PintarCompacta(Graphics g, GraphicsPath forma)
    {
        const TextFormatFlags corta = TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine;
        bool vivo = !Ev.Aplazado && Ev.Vivo;
        using (var borde = new Pen(encima ? Tema.Acento : vivo ? Color.FromArgb(150, 60, 60) : Tema.Linea, vivo || encima ? 2 : 1)) g.DrawPath(borde, forma);
        string dia = Ev.Inicio.Date == DateTime.Today ? "" : Ev.Inicio.Date == DateTime.Today.AddDays(1) ? "Mañana " : Ev.Inicio.ToString("ddd ");
        string cuando = Ev.Aplazado ? "APLAZADO" : vivo ? "EN DIRECTO" : dia + Ev.Inicio.ToString("HH:mm");
        var tam = TextRenderer.MeasureText(g, cuando, Tema.Pequena, new Size(1000, 30), TextFormatFlags.NoPadding);
        var insignia = new Rectangle(Width - tam.Width - 30, 12, tam.Width + 16, 22);
        using (var f2 = Tema.Redondeado(insignia, 4))
        using (var b = new SolidBrush(vivo ? Tema.Directo : Tema.Panel2)) g.FillPath(b, f2);
        TextRenderer.DrawText(g, cuando, Tema.Pequena, insignia, vivo ? Color.White : Tema.Texto, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        string comp = (Ev.Competicion.Length > 0 ? Ev.Competicion : Ev.Deporte).ToUpperInvariant();
        TextRenderer.DrawText(g, comp, Tema.Pequena, new Rectangle(16, 12, Math.Max(10, insignia.Left - 24), 22), Tema.Tenue, corta);
        TextRenderer.DrawText(g, Ev.Titulo.Replace(" - ", " – "), Tema.Negrita, new Rectangle(16, 42, Width - 32, 30), Tema.Texto, corta);
        // Canal con su punto de estado y el botón de ver
        int yPie = Height - 38;
        using (var p = new SolidBrush(Donde.Vivo ? Color.FromArgb(90, 200, 120) : Donde.Estado == "no_peers" ? Color.FromArgb(230, 190, 70) : Color.FromArgb(150, 150, 150)))
            g.FillEllipse(p, 16, yPie + 10, 9, 9);
        TextRenderer.DrawText(g, Donde.Titulo, Tema.Normal, new Rectangle(32, yPie, Width - 90, 28), Tema.Texto, corta);
        var play = new Rectangle(Width - 46, yPie - 2, 30, 30);
        using (var b = new SolidBrush(vivo ? Tema.Acento : Tema.Panel2)) g.FillEllipse(b, play);
        TextRenderer.DrawText(g, "\uE768", Tema.IconosPeq, play, vivo ? Tema.Fondo : Tema.Texto, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
    }
}

// Colores de los menús desplegables (el de Ajustes y el del botón derecho)
sealed class ColoresOscuros : ProfessionalColorTable
{
    public override Color MenuItemSelected => Tema.Panel2;
    public override Color MenuItemSelectedGradientBegin => Tema.Panel2;
    public override Color MenuItemSelectedGradientEnd => Tema.Panel2;
    public override Color MenuItemBorder => Tema.Panel2;
    public override Color ToolStripDropDownBackground => Tema.Panel1;
    public override Color ImageMarginGradientBegin => Tema.Panel1;
    public override Color ImageMarginGradientMiddle => Tema.Panel1;
    public override Color ImageMarginGradientEnd => Tema.Panel1;
    public override Color MenuBorder => Tema.Linea;
    public override Color SeparatorDark => Tema.Linea;
    public override Color SeparatorLight => Tema.Linea;
}

// Agenda a pantalla completa, en lista como la de Marca: un bloque por día y, en cada evento, deporte y hora a la izquierda,
// competición y partido en el centro y el canal por el que lo ves a la derecha.
sealed class VistaAgenda : Panel
{
    sealed record Cab(string Texto);

    readonly BarraFiltros chips = new() { Dock = DockStyle.Top };
    readonly ListBox lista = new() { Dock = DockStyle.Fill, DrawMode = DrawMode.OwnerDrawVariable, BorderStyle = BorderStyle.None, IntegralHeight = false, BackColor = Tema.Principal, ForeColor = Tema.Texto };
    List<Evento> eventos = new();
    DateTime? dia = DateTime.Today;   // null = todos los días
    readonly Panel destacados = new() { Dock = DockStyle.Top, Height = 0, BackColor = Tema.Principal, Padding = new Padding(14, 12, 14, 0) };
    readonly List<Tarjeta> tarjetas = new();
    string deporte = "";      // "" = todos los deportes
    string texto = "";
    bool soloConCanal = true;
    bool primeraVez = true;

    public Func<Evento, Canal?> CanalDe = _ => null;
    public Action<Evento>? Elegido;       // clic en el evento: su ficha
    public Action<Evento>? Reproducir;    // clic en el ▶ de la derecha: a verlo
    public Action<bool>? CambioSoloConCanal;

    public VistaAgenda(bool soloConCanalInicial)
    {
        soloConCanal = soloConCanalInicial;
        Dock = DockStyle.Fill;
        BackColor = Tema.Principal;
        Visible = false;
        Controls.Add(lista);
        Controls.Add(chips);
        Controls.Add(destacados);
        destacados.Resize += (_, _) => ColocarDestacados();
        lista.MeasureItem += (_, e) => e.ItemHeight = e.Index >= 0 && e.Index < lista.Items.Count && lista.Items[e.Index] is Cab ? 46 : 66;
        lista.DrawItem += Pintar;
        lista.SelectedIndexChanged += (_, _) =>
        {
            if (lista.SelectedItem is Cab && lista.SelectedIndex + 1 < lista.Items.Count) lista.SelectedIndex++;
        };
        lista.MouseUp += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            int i = lista.IndexFromPoint(e.Location);
            if (i < 0 || lista.Items[i] is not Evento ev) return;
            lista.SelectedIndex = i;
            bool alPlay = e.X > lista.ClientSize.Width - 70 && CanalDe(ev) != null;
            if (alPlay) Reproducir?.Invoke(ev); else Elegido?.Invoke(ev);
        };
        lista.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Enter && lista.SelectedItem is Evento ev) { Elegido?.Invoke(ev); e.Handled = true; }
        };
        lista.Resize += (_, _) => lista.Invalidate();
    }

    public string Texto { get => texto; set { texto = value ?? ""; MontarChips(); Rellenar(false); } }

    // Los cuadrados de arriba (Hoy): los mejores eventos del día con canal mío
    public void PonerDestacados(List<(Evento Ev, Canal Canal)> lista_)
    {
        destacados.SuspendLayout();
        foreach (var t in tarjetas) { destacados.Controls.Remove(t); t.Dispose(); }
        tarjetas.Clear();
        foreach (var (ev, canal) in lista_.Take(3))
        {
            var tj = new Tarjeta(ev, canal) { Compacta = true, Height = 120 };
            var e = ev;
            tj.Click += (_, _) => Reproducir?.Invoke(e);
            tarjetas.Add(tj);
            destacados.Controls.Add(tj);
        }
        destacados.Height = tarjetas.Count > 0 ? 132 : 0;
        destacados.ResumeLayout();
        ColocarDestacados();
    }

    void ColocarDestacados()
    {
        if (tarjetas.Count == 0) return;
        int hueco = 12, x = destacados.Padding.Left;
        int ancho = (destacados.ClientSize.Width - destacados.Padding.Horizontal - hueco * 2) / 3;
        foreach (var t in tarjetas) { t.SetBounds(x, destacados.Padding.Top, Math.Max(160, ancho), 120); x += ancho + hueco; }
    }

    public void Repintar() { foreach (var t in tarjetas) t.Invalidate(); lista.Invalidate(); }

    public void Cargar(List<Evento> nuevos)
    {
        eventos = nuevos;
        MontarChips();
        Rellenar(primeraVez);
        primeraVez = false;
    }

    public void Enfocar() => lista.Focus();

    static string Simple(string? t)
    {
        string n = (t ?? "").Trim().ToLowerInvariant().Normalize(System.Text.NormalizationForm.FormD);
        var sb = new System.Text.StringBuilder(n.Length);
        foreach (char c in n)
            if (System.Globalization.CharUnicodeInfo.GetUnicodeCategory(c) != System.Globalization.UnicodeCategory.NonSpacingMark) sb.Append(c);
        return sb.ToString();
    }

    static readonly System.Globalization.CultureInfo Es = System.Globalization.CultureInfo.GetCultureInfo("es-ES");
    static string NombreDia(DateTime d)
    {
        if (d.Date == DateTime.Today) return "Hoy";
        if (d.Date == DateTime.Today.AddDays(1)) return "Mañana";
        string t = d.ToString("dddd d", Es);
        return char.ToUpper(t[0]) + t[1..];
    }

    bool Pasa(Evento ev) => !soloConCanal || CanalDe(ev) != null;
    bool DelDia(Evento ev) => dia == null || ev.Inicio.Date == dia.Value.Date || (ev.Vivo && dia.Value.Date == DateTime.Today);

    // Una fila de selectores (día, qué eventos, deporte); cada uno abre su menú
    void MontarChips()
    {
        bool buscando = Simple(texto).Trim().Length > 0;
        var l = new List<BarraFiltros.Filtro>
        {
            new((buscando ? "Todos los días (buscando)" : dia == null ? "Todos los días" : NombreDia(dia.Value)) + "   ▾", false, MenuDias, false),
            new((soloConCanal ? "Con mi canal" : "Todos los eventos") + "   ▾", false, MenuFiltro, false),
            new((deporte.Length > 0 ? Icono(deporte) + "  " + deporte : "Todos los deportes") + "   ▾", deporte.Length > 0, MenuDeportes, false),
        };
        chips.Poner(l);
    }

    void Menu(IEnumerable<(string Texto, bool Marcado, Action Hacer)> opciones)
    {
        var m = new ContextMenuStrip { Renderer = new ToolStripProfessionalRenderer(new ColoresOscuros()), ForeColor = Tema.Texto, Font = new Font("Segoe UI", 10f), ShowCheckMargin = true, ShowImageMargin = false };
        foreach (var o in opciones)
        {
            var it = new ToolStripMenuItem(o.Texto) { Checked = o.Marcado, ForeColor = Tema.Texto, Padding = new Padding(0, 3, 0, 3) };
            var hacer = o.Hacer;
            it.Click += (_, _) => { hacer(); MontarChips(); Rellenar(true); };
            m.Items.Add(it);
        }
        m.Closed += (_, _) => BeginInvoke(new Action(m.Dispose));
        var r = chips.Pulsado;
        m.Show(chips, new Point(r.Left, r.Bottom + 4));
    }

    void MenuDias()
    {
        var dias = eventos.Select(e => e.Inicio.Date).Where(d => d >= DateTime.Today).Distinct().OrderBy(d => d).Take(10).ToList();
        if (!dias.Contains(DateTime.Today)) dias.Insert(0, DateTime.Today);
        var ops = dias.Select(d => ($"{NombreDia(d)}   ({eventos.Count(e => Pasa(e) && (e.Inicio.Date == d || (d == DateTime.Today && e.Vivo)))})", dia?.Date == d, (Action)(() => { dia = d; deporte = ""; }))).ToList();
        ops.Add(("Todos los días", dia == null, () => dia = null));
        Menu(ops);
    }

    void MenuFiltro() => Menu(new (string, bool, Action)[]
    {
        ("Con mi canal (los que puedes ver)", soloConCanal, () => { soloConCanal = true; CambioSoloConCanal?.Invoke(true); }),
        ("Todos los eventos", !soloConCanal, () => { soloConCanal = false; CambioSoloConCanal?.Invoke(false); }),
    });

    void MenuDeportes()
    {
        var del = eventos.Where(e => Pasa(e) && DelDia(e)).ToList();
        var ops = new List<(string, bool, Action)> { ($"Todos los deportes   ({del.Count})", deporte.Length == 0, () => deporte = "") };
        foreach (var g in del.Where(e => e.Deporte.Length > 0).GroupBy(e => e.Deporte).OrderByDescending(g => g.Count()))
        {
            string d = g.Key;
            ops.Add(($"{Icono(d)}  {d}   ({g.Count()})", deporte == d, () => deporte = d));
        }
        Menu(ops);
    }

    static string Icono(string deporte)
    {
        string d = Simple(deporte);
        if (d.Contains("baloncesto")) return "🏀";
        if (d.Contains("tenis") || d.Contains("padel")) return "🎾";
        if (d.Contains("golf")) return "⛳";
        if (d.Contains("esqui") || d.Contains("nieve")) return "⛷";
        if (d.Contains("motor") || d.Contains("formula") || d.Contains("moto") || d.Contains("rally")) return "🏁";
        if (d.Contains("ciclismo")) return "🚴";
        if (d.Contains("balonmano")) return "🤾";
        if (d.Contains("rugby")) return "🏉";
        if (d.Contains("boxeo") || d.Contains("mma") || d.Contains("lucha")) return "🥊";
        if (d.Contains("futbol") || d.Contains("sala")) return "⚽";
        return "🏆";
    }

    void Rellenar(bool irAhora)
    {
        var palabras = Simple(texto).Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var vistos = eventos.Where(ev =>
            (deporte.Length == 0 || ev.Deporte == deporte) &&
            (palabras.Length > 0 || !soloConCanal || CanalDe(ev) != null) &&
            (palabras.Length > 0 || DelDia(ev)) &&
            (palabras.Length == 0 || palabras.All(p => Simple(ev.Titulo + " " + ev.Competicion + " " + ev.Deporte).Contains(p)))).OrderBy(e => e.Inicio).ToList();
        object? antes = lista.SelectedItem;
        lista.BeginUpdate();
        lista.Items.Clear();
        DateTime dia = DateTime.MinValue;
        int primeroAhora = -1;
        var ahora = DateTime.Now;
        foreach (var ev in vistos)
        {
            if (ev.Inicio.Date != dia)
            {
                dia = ev.Inicio.Date;
                string nombre = dia == DateTime.Today ? "Hoy" : dia == DateTime.Today.AddDays(1) ? "Mañana" : dia == DateTime.Today.AddDays(-1) ? "Ayer" : "";
                string largo = dia.ToString("dddd, d 'de' MMMM", Es);
                largo = char.ToUpper(largo[0]) + largo[1..];
                lista.Items.Add(new Cab(nombre.Length > 0 ? $"{nombre} · {largo}" : largo));
            }
            if (primeroAhora < 0 && (ev.Vivo || ev.Inicio > ahora)) primeroAhora = lista.Items.Count;
            lista.Items.Add(ev);
        }
        if (vistos.Count == 0) lista.Items.Add(new Cab(palabras.Length > 0 ? "Ningún evento con eso" : soloConCanal ? "Ningún evento de este día tiene canal entre tus listas (elige «Todos los eventos» u otro día)" : "No hay eventos este día"));
        lista.EndUpdate();
        if (antes is Evento a && !irAhora)
        {
            int i = lista.Items.IndexOf(a);
            if (i >= 0) lista.SelectedIndex = i;
        }
        else if (primeroAhora >= 0)
        {
            lista.TopIndex = Math.Max(0, primeroAhora - (primeroAhora > 0 && lista.Items[primeroAhora - 1] is Cab ? 1 : 0));
            lista.SelectedIndex = primeroAhora;
        }
    }

    void Pintar(object? s, DrawItemEventArgs e)
    {
        if (e.Index < 0 || e.Index >= lista.Items.Count) return;
        var g = e.Graphics;
        using (var fondo = new SolidBrush(Tema.Principal)) g.FillRectangle(fondo, e.Bounds);
        const TextFormatFlags corta = TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine;
        if (lista.Items[e.Index] is Cab c)
        {
            var r = new Rectangle(e.Bounds.Left + 12, e.Bounds.Top + 8, e.Bounds.Width - 24, e.Bounds.Height - 10);
            using (var b = new SolidBrush(Tema.Panel2)) g.FillRectangle(b, r);
            TextRenderer.DrawText(g, c.Texto, Tema.Negrita, new Rectangle(r.Left + 12, r.Top, r.Width - 16, r.Height), Tema.Texto, corta);
            return;
        }
        if (lista.Items[e.Index] is not Evento ev) return;
        bool sel = (e.State & DrawItemState.Selected) != 0;
        var fila = new Rectangle(e.Bounds.Left + 12, e.Bounds.Top + 3, e.Bounds.Width - 24, e.Bounds.Height - 6);
        using (var b = new SolidBrush(sel ? Tema.Panel2 : Tema.Panel1)) g.FillRectangle(b, fila);
        // Bloque de la izquierda: deporte y hora
        var bloque = new Rectangle(fila.Left, fila.Top, 78, fila.Height);
        using (var b = new SolidBrush(sel ? Color.FromArgb(72, 72, 72) : Tema.Fondo)) g.FillRectangle(b, bloque);
        using var fEmoji = new Font("Segoe UI Emoji", 12f);
        TextRenderer.DrawText(g, Icono(ev.Deporte), fEmoji, new Rectangle(bloque.Left, bloque.Top + 4, bloque.Width, 26), Tema.Texto, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        string cuando = ev.Aplazado ? "APLAZ." : ev.Vivo ? "DIRECTO" : ev.Inicio.ToString("HH:mm");
        var colorHora = ev.Vivo && !ev.Aplazado ? Tema.Directo : Tema.Texto;
        TextRenderer.DrawText(g, cuando, ev.Vivo ? Tema.Pequena : Tema.Negrita, new Rectangle(bloque.Left, bloque.Top + 30, bloque.Width, bloque.Height - 32), colorHora, TextFormatFlags.HorizontalCenter | TextFormatFlags.Top | TextFormatFlags.NoPadding);
        // Derecha: el canal
        var canal = CanalDe(ev);
        int anchoDer = Math.Max(150, fila.Width / 3);
        var rDer = new Rectangle(fila.Right - anchoDer, fila.Top, anchoDer - 8, fila.Height);
        string donde = canal != null ? canal.Titulo : ev.Canales.Length > 0 ? ev.Canales : "Sin canal";
        Color colorDonde = canal != null ? Tema.Texto : Tema.Tenue;
        if (canal != null)
        {
            using var p = new SolidBrush(canal.Estado == "alive" || canal.EsTv ? Color.FromArgb(90, 200, 120) : canal.Estado == "no_peers" ? Color.FromArgb(230, 190, 70) : Color.FromArgb(150, 150, 150));
            g.SmoothingMode = SmoothingMode.AntiAlias;
            // El punto va pegado al nombre del canal (que se alinea a la derecha)
            var rTxt = new Rectangle(rDer.Left + 16, rDer.Top, rDer.Width - 16 - 58, rDer.Height);
            int anchoTxt = Math.Min(rTxt.Width, TextRenderer.MeasureText(g, ev.Posible ? "¿" + donde + "?" : donde, Tema.Normal, new Size(rTxt.Width, rTxt.Height), corta).Width);
            g.FillEllipse(p, rTxt.Right - anchoTxt - 16, fila.Top + fila.Height / 2 - 5, 10, 10);
            var play = new Rectangle(fila.Right - 54, fila.Top + fila.Height / 2 - 16, 32, 32);
            using (var b = new SolidBrush(ev.Vivo ? Tema.Acento : Tema.Panel2)) g.FillEllipse(b, play);
            TextRenderer.DrawText(g, "", Tema.IconosPeq, play, ev.Vivo ? Tema.Fondo : Tema.Texto, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            TextRenderer.DrawText(g, (ev.Posible ? "¿" + donde + "?" : donde), Tema.Normal, new Rectangle(rDer.Left + 16, rDer.Top, rDer.Width - 16 - 58, rDer.Height), colorDonde, corta | TextFormatFlags.Right);
        }
        else TextRenderer.DrawText(g, donde, Tema.Pequena, new Rectangle(rDer.Left, rDer.Top, rDer.Width, rDer.Height), colorDonde, corta | TextFormatFlags.Right);
        // Centro: competición y partido
        int x = bloque.Right + 14;
        int ancho = Math.Max(60, rDer.Left - x - 10);
        TextRenderer.DrawText(g, (ev.Favorito ? "★ " : "") + (ev.Competicion.Length > 0 ? ev.Competicion.ToUpperInvariant() : ev.Deporte.ToUpperInvariant()), Tema.Pequena, new Rectangle(x, fila.Top + 7, ancho, 18), Tema.Tenue, corta);
        TextRenderer.DrawText(g, ev.Titulo.Replace(" - ", " – "), Tema.Negrita, new Rectangle(x, fila.Top + 26, ancho, 28), ev.Favorito ? Tema.Acento : canal != null ? Tema.Texto : Tema.Tenue, corta);
    }
}

// Fila de filtros de la agenda dibujada a mano: píldoras que bajan a otra línea si no caben (sin barra de desplazamiento ni botones cortados)
sealed class BarraFiltros : Control
{
    public sealed record Filtro(string Texto, bool Activo, Action Pulsar, bool Aparte);

    List<Filtro> filtros = new();
    readonly List<Rectangle> sitios = new();
    public Rectangle Pulsado;      // el último filtro pulsado: su menú se abre debajo
    int encima = -1;
    const int Alto = 32, MargenX = 14, MargenY = 10, Hueco = 8;

    public BarraFiltros()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = Tema.Principal;
        Font = new Font("Segoe UI", 9.5f);
        Height = Alto + MargenY * 2;
    }

    public void Poner(List<Filtro> nuevos) { filtros = nuevos; Colocar(); Invalidate(); }

    protected override void OnResize(EventArgs e) { base.OnResize(e); Colocar(); }

    void Colocar()
    {
        sitios.Clear();
        int x = MargenX, y = MargenY, ancho = Math.Max(ClientSize.Width, 200);
        foreach (var f in filtros)
        {
            int w = TextRenderer.MeasureText(f.Texto, Font, new Size(int.MaxValue, Alto), TextFormatFlags.NoPadding).Width + 28;
            if (x > MargenX && x + w > ancho - MargenX) { x = MargenX; y += Alto + Hueco; }
            sitios.Add(new Rectangle(x, y, w, Alto));
            x += w + (f.Aparte ? 18 : Hueco);
        }
        int alto = y + Alto + MargenY;
        if (Height != alto) Height = alto;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(BackColor);
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        for (int i = 0; i < filtros.Count && i < sitios.Count; i++)
        {
            var f = filtros[i]; var r = sitios[i];
            using var camino = Tema.Redondeado(r, Alto / 2);
            using var pincel = new SolidBrush(f.Activo ? Tema.Acento : i == encima ? Tema.Panel2 : Tema.Panel1);
            g.FillPath(pincel, camino);
            TextRenderer.DrawText(g, f.Texto, Font, r, f.Activo ? Tema.Fondo : Tema.Texto,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
        }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        int i = sitios.FindIndex(r => r.Contains(e.Location));
        if (i != encima) { encima = i; Cursor = i >= 0 ? Cursors.Hand : Cursors.Default; Invalidate(); }
    }

    protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); if (encima >= 0) { encima = -1; Invalidate(); } }

    protected override void OnMouseClick(MouseEventArgs e)
    {
        base.OnMouseClick(e);
        if (e.Button != MouseButtons.Left) return;
        int i = sitios.FindIndex(r => r.Contains(e.Location));
        if (i >= 0 && i < filtros.Count) { Pulsado = sitios[i]; BeginInvoke(filtros[i].Pulsar); }
    }
}
