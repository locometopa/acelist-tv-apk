// Puente con el panel del móvil.
// La página del móvil habla con un pequeño servidor (en la tele: el de la APK;
// en el PC: servidor.js). Ese servidor pasa cada petición /api/... a esta app,
// que la resuelve con sus datos y devuelve la respuesta.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Clave corta y fácil de teclear (sin letras que se confundan: i, l, o, 0, 1)
export function newToken() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map((b) => abc[b % abc.length]).join('');
}

export class Puente {
  constructor({ native, plugin, handler }) {
    this.native = native;
    this.plugin = plugin;
    this.handler = handler;
    this.activo = false;
    this.info = null; // {ip, puerto}
    this.listener = null;
    this.loopId = 0;
  }

  async responder(req) {
    let status = 200;
    let body;
    try {
      body = await this.handler(req.method, req.path, req.body ? JSON.parse(req.body) : {});
    } catch (e) {
      status = e.status || 400;
      body = { error: e.message || String(e) };
    }
    return { id: req.id, status, body: JSON.stringify(body ?? {}) };
  }

  async iniciar(token, puerto) {
    await this.detener();
    if (this.native) {
      this.listener = await this.plugin.addListener('peticion', async (req) => {
        const r = await this.responder(req);
        this.plugin.responder(r);
      });
      const info = await this.plugin.iniciarServidor({ token, puerto });
      this.info = { ip: info.ip, puerto: info.puerto };
    } else {
      const res = await fetch('/puente/iniciar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, puerto }),
      });
      if (!res.ok) throw new Error(await res.text());
      const info = await res.json();
      this.info = { ip: info.ip, puerto: info.puerto };
      this.bucle(++this.loopId);
    }
    this.activo = true;
    return this.info;
  }

  // Versión web: espera peticiones del servidor local (long polling).
  async bucle(id) {
    while (id === this.loopId) {
      try {
        const res = await fetch('/puente/siguiente', { cache: 'no-store' });
        if (id !== this.loopId) return;
        if (res.status === 200) {
          const req = await res.json();
          const r = await this.responder(req);
          await fetch('/puente/respuesta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(r),
          });
        } else if (res.status !== 204) {
          await sleep(3000);
        }
      } catch {
        await sleep(3000);
      }
    }
  }

  async detener() {
    this.loopId++;
    if (!this.activo) return;
    this.activo = false;
    try {
      if (this.native) {
        if (this.listener) await this.listener.remove();
        await this.plugin.detenerServidor();
      } else {
        await fetch('/puente/detener', { method: 'POST' });
      }
    } catch {
      /* ya estaba parado */
    }
  }

  url(token) {
    return this.info ? `http://${this.info.ip}:${this.info.puerto}/${token}` : '';
  }
}
