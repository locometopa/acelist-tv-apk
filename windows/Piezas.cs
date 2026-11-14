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
        Size = new Size(68, 58);
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
        if (Activo) { using var a = new SolidBrush(Tema.Acento); g.FillRectangle(a, 0, 19, 3, 20); }
        Color color = !Enabled ? Color.FromArgb(100, 100, 100) : Encendido ? Tema.Acento : Activo ? Tema.Texto : Tema.Tenue;
        const TextFormatFlags centro = TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix;
        TextRenderer.DrawText(g, Glifo, Tema.Iconos, new Rectangle(0, 7, Width, 26), color, centro);
        TextRenderer.DrawText(g, Etiqueta, Tema.Pequena, new Rectangle(0, 34, Width, 18), color, centro);
    }
}

// Tarjeta de un partido: competición y hora arriba, los dos equipos y el canal por el que se ve
sealed class Tarjeta : Control
{
    public readonly Evento Ev;
    public readonly Canal Donde;
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

    readonly FlowLayoutPanel chips = new() { Dock = DockStyle.Top, Height = 46, Padding = new Padding(14, 8, 8, 0), BackColor = Tema.Principal, WrapContents = false, AutoScroll = true };
    readonly ListBox lista = new() { Dock = DockStyle.Fill, DrawMode = DrawMode.OwnerDrawVariable, BorderStyle = BorderStyle.None, IntegralHeight = false, BackColor = Tema.Principal, ForeColor = Tema.Texto };
    List<Evento> eventos = new();
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

    public string Texto { get => texto; set { texto = value ?? ""; Rellenar(false); } }

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

    void MontarChips()
    {
        chips.SuspendLayout();
        foreach (var c in chips.Controls.Cast<Control>().ToArray()) { chips.Controls.Remove(c); c.Dispose(); }
        chips.Controls.Add(Chip("Con mi canal", soloConCanal, () => { soloConCanal = !soloConCanal; CambioSoloConCanal?.Invoke(soloConCanal); MontarChips(); Rellenar(false); }, true));
        chips.Controls.Add(Chip("Todos", deporte.Length == 0, () => { deporte = ""; MontarChips(); Rellenar(false); }, false));
        foreach (var d in eventos.Where(e => e.Deporte.Length > 0).GroupBy(e => e.Deporte).OrderByDescending(g => g.Count()).Select(g => g.Key).Take(14))
        {
            string dep = d;
            chips.Controls.Add(Chip(Icono(dep) + " " + dep, deporte == dep, () => { deporte = deporte == dep ? "" : dep; MontarChips(); Rellenar(false); }, false));
        }
        chips.ResumeLayout();
    }

    Button Chip(string t, bool on, Action alPulsar, bool aparte)
    {
        var b = new Button { Text = t, AutoSize = true, Height = 30, FlatStyle = FlatStyle.Flat, TabStop = false, Margin = new Padding(0, 0, aparte ? 16 : 6, 0), Padding = new Padding(6, 0, 6, 0), Font = Tema.Pequena };
        b.FlatAppearance.BorderSize = 0;
        b.BackColor = on ? Tema.Acento : Tema.Panel1;
        b.ForeColor = on ? Tema.Fondo : Tema.Texto;
        b.Click += (_, _) => alPulsar();
        return b;
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
                string largo = System.Globalization.CultureInfo.GetCultureInfo("es-ES").TextInfo.ToTitleCase(dia.ToString("dddd d 'de' MMMM 'de' yyyy", System.Globalization.CultureInfo.GetCultureInfo("es-ES")));
                lista.Items.Add(new Cab(nombre.Length > 0 ? $"{nombre} · {largo}" : largo));
            }
            if (primeroAhora < 0 && (ev.Vivo || ev.Inicio > ahora)) primeroAhora = lista.Items.Count;
            lista.Items.Add(ev);
        }
        if (vistos.Count == 0) lista.Items.Add(new Cab(palabras.Length > 0 ? "Ningún evento con eso" : soloConCanal ? "Ningún evento de la agenda tiene canal entre tus listas (quita «Con mi canal» para ver todos)" : "No hay eventos en la agenda"));
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
            g.FillEllipse(p, rDer.Left, fila.Top + fila.Height / 2 - 5, 10, 10);
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
