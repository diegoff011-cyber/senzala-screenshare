// Senzala Screenshare - servidor de conexão
// Ele NÃO vê a tela de ninguém. Só faz os PCs se encontrarem pelo código
// e repassa os "recados" de conexão (WebRTC). A tela vai direto de PC para PC.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// Servidores STUN públicos de alta velocidade (Google, Cloudflare, Mozilla e STUN Protocol)
// 100% gratuitos, ilimitados e sem depender de contas ou APIs de terceiros.
const DEFAULT_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.stunprotocol.org:3478' }
];

let ICE_SERVERS = DEFAULT_STUN_SERVERS;
if (process.env.ICE_SERVERS) {
  try {
    const custom = JSON.parse(process.env.ICE_SERVERS);
    if (Array.isArray(custom) && custom.length) ICE_SERVERS = custom;
  } catch (e) {
    console.error('ICE_SERVERS inválido, mantendo STUNs públicos padrão.');
  }
}

let currentIce = ICE_SERVERS;

const server = http.createServer((req, res) => {
  // O Render usa isso para saber que o servidor está vivo.
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Senzala Screenshare OK');
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

const online = new Map(); // código -> { ws, token }
const owners = new Map(); // código -> { token, lastSeen }  (quem é o dono de cada código)

const isCode = (v) => typeof v === 'string' && /^\d{9}$/.test(v);
const send = (ws, obj) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
};

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.id = null;
  ws.peers = new Set(); // com quem este PC pode trocar recados
  ws.lastRequest = 0;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m.type !== 'string') return;

    // ---------- Registro: "este é o meu código" ----------
    if (m.type === 'register') {
      if (!isCode(m.id)) return send(ws, { type: 'error', reason: 'bad-id' });
      if (typeof m.token !== 'string' || m.token.length < 16 || m.token.length > 64) {
        return send(ws, { type: 'error', reason: 'bad-token' });
      }
      const owner = owners.get(m.id);
      if (owner && owner.token !== m.token) {
        return send(ws, { type: 'error', reason: 'id-in-use' });
      }
      const current = online.get(m.id);
      if (current && current.ws !== ws) current.ws.terminate(); // mesmo dono reconectando
      owners.set(m.id, { token: m.token, lastSeen: Date.now() });
      online.set(m.id, { ws, token: m.token });
      ws.id = m.id;
      return send(ws, { type: 'registered', id: m.id, iceServers: currentIce });
    }

    if (!ws.id) return;

    // ---------- Pedido de acesso ----------
    if (m.type === 'connect-request') {
      if (!isCode(m.to) || m.to === ws.id) return;
      const now = Date.now();
      if (now - ws.lastRequest < 2000) return; // evita spam de pedidos
      ws.lastRequest = now;
      const target = online.get(m.to);
      if (!target) return send(ws, { type: 'peer-not-found', to: m.to });
      ws.peers.add(m.to);
      target.ws.peers.add(ws.id);
      return send(target.ws, {
        type: 'incoming-request',
        from: ws.id,
        name: String(m.name || 'Alguém').slice(0, 40),
      });
    }

    // ---------- Recados entre os dois PCs ----------
    const relay = { accept: 'accepted', reject: 'rejected', signal: 'signal', hangup: 'hangup' };
    if (relay[m.type]) {
      if (!isCode(m.to) || !ws.peers.has(m.to)) return;
      const target = online.get(m.to);
      if (!target || !target.ws.peers.has(ws.id)) return;
      const out = { type: relay[m.type], from: ws.id };
      if (m.type === 'accept') out.control = m.control === true;
      if (m.type === 'reject') out.busy = m.busy === true;
      if (m.type === 'signal') out.data = m.data;
      send(target.ws, out);
      if (m.type === 'hangup' || m.type === 'reject') {
        ws.peers.delete(m.to);
        target.ws.peers.delete(ws.id);
      }
    }
  });

  ws.on('close', () => {
    if (!ws.id) return;
    const cur = online.get(ws.id);
    if (cur && cur.ws === ws) {
      online.delete(ws.id);
      const o = owners.get(ws.id);
      if (o) o.lastSeen = Date.now();
    }
    for (const p of ws.peers) {
      const t = online.get(p);
      if (t) {
        t.ws.peers.delete(ws.id);
        send(t.ws, { type: 'peer-left', id: ws.id });
      }
    }
  });

  ws.on('error', () => {});
});

// Derruba conexões "mortas" a cada 30s
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Esquece códigos que ficaram offline por mais de 30 dias
setInterval(() => {
  const limit = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [id, o] of owners) {
    if (!online.has(id) && o.lastSeen < limit) owners.delete(id);
  }
}, 60 * 60 * 1000);

server.listen(PORT, () => console.log('Senzala Screenshare rodando na porta ' + PORT));
