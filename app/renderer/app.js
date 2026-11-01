'use strict';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ estado
const S = {
  ws: null,
  cfg: null,
  id: '',
  token: '',
  name: '',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  phase: 'idle',        // idle | waiting | incoming | active
  role: null,           // 'host' (compartilha a tela) | 'viewer' (vê e controla)
  peerId: null,
  peerName: '',
  pc: null,
  dc: null,
  stream: null,
  pcConnected: false,
  control: false,       // o host permitiu controle?
  inputOn: true,        // o viewer quer controlar agora?
  kbActive: false,
  incoming: null,
  pendingIce: [],
  reconnectDelay: 1000,
  waitTimer: null,
  discTimer: null,
  lastMove: null,
  movePending: false,
};

const QUALITY = {
  equilibrada: { fps: 30, kbps: 6000 },
  alta: { fps: 60, kbps: 12000 },
  economia: { fps: 20, kbps: 2500 },
};

const fmt = (s) => String(s).replace(/\D/g, '').replace(/(\d{3})(?=\d)/g, '$1 ');
const digits = (s) => String(s).replace(/\D/g, '');

// ------------------------------------------------------------------ avisos
let toastTimer = null;
function toast(msg) {
  if (!msg) return;
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function setStatus(state, text) {
  $('status').dataset.state = state;
  $('statusText').textContent = text;
  updateConnectButton();
}

function updateConnectButton() {
  const ok = S.ws && S.ws.readyState === 1 && S.id && S.phase === 'idle' &&
    digits($('remoteCode').value).length === 9;
  $('connectBtn').disabled = !ok;
}

// ------------------------------------------------------------ servidor (WebSocket)
function sendWS(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}

function connectWS() {
  if (!S.cfg.servidor || S.cfg.servidor.includes('COLOQUE-AQUI')) {
    setStatus('offline', 'Endereço do servidor não configurado (arquivo config.json)');
    return;
  }
  setStatus('connecting', 'Conectando ao servidor… (o primeiro acesso do dia pode levar até 1 minuto)');
  let ws;
  try {
    ws = new WebSocket(S.cfg.servidor);
  } catch (e) {
    setStatus('offline', 'Endereço do servidor inválido (arquivo config.json)');
    return;
  }
  S.ws = ws;

  ws.onopen = () => {
    S.reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: 'register', id: S.id, token: S.token, name: S.name }));
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    onServerMessage(m);
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.ws = null;
    setStatus('offline', 'Sem conexão com o servidor. Tentando de novo…');
    // Se ainda estava só esperando resposta, cancela. Se o vídeo já está rodando, segue normal.
    if (S.phase !== 'idle' && !S.pcConnected) endSession('A conexão com o servidor caiu.', false);
    setTimeout(connectWS, S.reconnectDelay);
    S.reconnectDelay = Math.min(Math.round(S.reconnectDelay * 1.5), 10000);
  };
  ws.onerror = () => {};
}

setInterval(() => sendWS({ type: 'ping' }), 25000);

async function onServerMessage(m) {
  switch (m.type) {
    case 'registered':
      if (Array.isArray(m.iceServers) && m.iceServers.length) S.iceServers = m.iceServers;
      setStatus('online', 'Online. Pronto para receber acessos');
      break;

    case 'error':
      if (m.reason === 'id-in-use') {
        const d = await window.api.newId();
        S.id = d.id; S.token = d.token;
        $('myCode').textContent = fmt(S.id);
        sendWS({ type: 'register', id: S.id, token: S.token, name: S.name });
      }
      break;

    case 'peer-not-found':
      if (S.phase === 'waiting') endSession('Código não encontrado, ou o outro PC está desligado.', false);
      break;

    case 'incoming-request':
      onIncoming(m);
      break;

    case 'accepted':
      startViewer(m.from, m.control === true);
      break;

    case 'rejected':
      if (S.phase === 'waiting' && m.from === S.peerId) {
        endSession(m.busy ? 'O outro PC está ocupado com outra conexão.' : 'O outro PC recusou o acesso.', false);
      }
      break;

    case 'signal':
      handleSignal(m.from, m.data);
      break;

    case 'hangup':
      if (m.from === S.peerId) endSession('O outro lado encerrou a conexão.', false);
      break;

    case 'peer-left':
      if (m.id === S.peerId && !S.pcConnected) endSession('O outro PC ficou offline.', false);
      break;
  }
}

// ------------------------------------------------------------ quem quer ACESSAR (viewer)
function connectToRemote() {
  const code = digits($('remoteCode').value);
  if (code.length !== 9 || S.phase !== 'idle') return;
  if (code === S.id) { toast('Esse é o seu próprio código.'); return; }
  S.phase = 'waiting';
  S.role = 'viewer';
  S.peerId = code;
  sendWS({ type: 'connect-request', to: code, name: S.name });
  $('waitText').textContent = 'O pedido foi enviado para ' + fmt(code) + '. Peça para a outra pessoa aceitar.';
  $('wait').hidden = false;
  updateConnectButton();
  clearTimeout(S.waitTimer);
  S.waitTimer = setTimeout(() => endSession('Ninguém aceitou o pedido a tempo.'), 60000);
}

function startViewer(from, control) {
  if (S.phase !== 'waiting' || from !== S.peerId) return;
  clearTimeout(S.waitTimer);
  $('wait').hidden = true;
  S.phase = 'active';
  S.control = control;
  S.inputOn = control;
  const pc = (S.pc = makePC());
  pc.ontrack = (e) => {
    const v = $('video');
    if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
    showViewer();
  };
  pc.ondatachannel = (e) => {
    S.dc = e.channel;
    S.dc.onmessage = onChannelMessage;
  };
}

function showViewer() {
  $('home').hidden = true;
  $('viewer').hidden = false;
  $('viewerInfo').textContent = 'Conectado a ' + fmt(S.peerId);
  $('ctlBtn').hidden = !S.control;
  updateControlButton();
  $('screen').focus();
}

function updateControlButton() {
  $('ctlBtn').textContent = 'Controle: ' + (S.inputOn ? 'ligado' : 'desligado');
}

// ------------------------------------------------------------ quem DEIXA acessar (host)
function onIncoming(m) {
  if (S.phase !== 'idle') {
    sendWS({ type: 'reject', to: m.from, busy: true });
    return;
  }
  S.phase = 'incoming';
  S.incoming = { from: m.from, name: String(m.name || 'Alguém').slice(0, 40) };
  $('modalText').textContent = '';
  const b = document.createElement('strong');
  b.textContent = S.incoming.name;
  $('modalText').append(b, ' (código ' + fmt(m.from) + ') quer acessar o seu PC.');
  $('accCtl').hidden = S.cfg.platform !== 'win32';
  $('modal').hidden = false;
  window.api.attention();
  updateConnectButton();
}

function hideModal() { $('modal').hidden = true; }

async function acceptRequest(withControl) {
  const req = S.incoming;
  if (!req) return;
  hideModal();
  const q = QUALITY[$('quality').value] || QUALITY.equilibrada;

  // Importante: a captura de tela é pedida logo no clique (o Windows exige esse gesto).
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: q.fps, max: q.fps } },
      audio: false,
    });
  } catch (e) {
    sendWS({ type: 'reject', to: req.from });
    resetState();
    toast('Não foi possível capturar a tela.');
    return;
  }
  if (S.incoming !== req) { // o outro lado cancelou enquanto isso
    stream.getTracks().forEach((t) => t.stop());
    return;
  }

  S.stream = stream;
  S.role = 'host';
  S.phase = 'active';
  S.peerId = req.from;
  S.peerName = req.name;
  S.incoming = null;
  S.control = withControl && S.cfg.platform === 'win32';
  if (S.control) {
    const ok = await window.api.inputStart();
    if (!ok) S.control = false;
  }
  sendWS({ type: 'accept', to: req.from, control: S.control });

  stream.getVideoTracks()[0].addEventListener('ended', () => {
    endSession('O compartilhamento de tela foi interrompido.');
  });

  const pc = (S.pc = makePC());
  stream.getTracks().forEach((t) => {
    t.contentHint = 'motion';
    pc.addTrack(t, stream);
  });
  S.dc = pc.createDataChannel('ctl', { ordered: true });
  S.dc.onmessage = onChannelMessage;

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWS({ type: 'signal', to: S.peerId, data: { sdp: pc.localDescription } });
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = q.kbps * 1000;
      p.encodings[0].maxFramerate = q.fps;
      p.degradationPreference = 'maintain-framerate';
      await sender.setParameters(p);
    }
  } catch (e) {
    endSession('Falha ao iniciar a conexão.');
  }
  updateConnectButton();
}

function rejectRequest() {
  if (!S.incoming) return;
  sendWS({ type: 'reject', to: S.incoming.from });
  hideModal();
  resetState();
}

function updateHostBox() {
  const show = S.role === 'host' && S.phase === 'active' && S.pcConnected;
  $('hostBox').hidden = !show;
  if (show) $('hostText').textContent = S.peerName + (S.control ? ' está controlando seu PC' : ' está vendo sua tela');
}

// ------------------------------------------------------------ WebRTC
function makePC() {
  S.pcConnected = false;
  S.pendingIce = [];
  const pc = new RTCPeerConnection({ iceServers: S.iceServers });

  pc.onicecandidate = (e) => {
    if (e.candidate && S.peerId) sendWS({ type: 'signal', to: S.peerId, data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (S.pc !== pc) return;
    const st = pc.connectionState;
    clearTimeout(S.discTimer);
    if (st === 'connected') {
      S.pcConnected = true;
      if (S.role === 'host') {
        window.api.showBar({ name: S.peerName, control: S.control });
        updateHostBox();
      }
    } else if (st === 'failed' || st === 'closed') {
      endSession('A conexão com o outro PC foi perdida.', false);
    } else if (st === 'disconnected') {
      S.discTimer = setTimeout(() => {
        if (S.pc === pc && pc.connectionState === 'disconnected') endSession('A conexão com o outro PC foi perdida.', false);
      }, 8000);
    }
  };
  return pc;
}

async function handleSignal(from, data) {
  if (!S.pc || from !== S.peerId || !data) return;
  const pc = S.pc;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendWS({ type: 'signal', to: S.peerId, data: { sdp: pc.localDescription } });
      }
      for (const c of S.pendingIce) await pc.addIceCandidate(c);
      S.pendingIce = [];
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else S.pendingIce.push(data.candidate);
    }
  } catch (e) {
    console.error('signal', e);
  }
}

// mensagens que viajam direto entre os PCs
function sendDC(obj) {
  if (S.dc && S.dc.readyState === 'open') S.dc.send(JSON.stringify(obj));
}

const isInt = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

function onChannelMessage(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'bye') { endSession('O outro lado encerrou a conexão.', false); return; }

  // daqui para baixo: só o host recebe comandos, e só se permitiu controle
  if (S.role !== 'host' || !S.control) return;
  switch (m.t) {
    case 'm':
      if (isInt(m.x, 10000) && isInt(m.y, 10000)) window.api.inputSend('M ' + m.x + ' ' + m.y);
      break;
    case 'd':
    case 'u':
      if (m.b === 0 || m.b === 1 || m.b === 2) window.api.inputSend((m.t === 'd' ? 'D ' : 'U ') + m.b);
      break;
    case 'w':
      if (Number.isInteger(m.d) && Math.abs(m.d) <= 3000) window.api.inputSend('W ' + m.d);
      break;
    case 'k':
      if (isInt(m.s, 255) && (m.e === 0 || m.e === 1) && (m.dn === 0 || m.dn === 1)) {
        window.api.inputSend('K ' + m.s + ' ' + m.e + ' ' + m.dn);
      }
      break;
    case 'r':
      window.api.inputSend('R');
      break;
  }
}

// ------------------------------------------------------------ encerrar
function resetState() {
  clearTimeout(S.waitTimer);
  clearTimeout(S.discTimer);
  S.phase = 'idle';
  S.role = null;
  S.peerId = null;
  S.peerName = '';
  S.pc = null;
  S.dc = null;
  S.stream = null;
  S.pcConnected = false;
  S.control = false;
  S.inputOn = true;
  S.kbActive = false;
  S.incoming = null;
  S.pendingIce = [];
  updateHostBox();
  updateConnectButton();
}

function endSession(msg, notify = true) {
  if (S.phase === 'idle') return;
  const { pc, dc, stream, peerId } = S;
  if (notify && peerId) {
    try { if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ t: 'bye' })); } catch (e) { /* ok */ }
    sendWS({ type: 'hangup', to: peerId });
  }
  resetState();
  try { if (dc) dc.close(); } catch (e) { /* ok */ }
  try { if (pc) pc.close(); } catch (e) { /* ok */ }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  $('video').srcObject = null;
  if (document.fullscreenElement) document.exitFullscreen();
  window.api.inputStop();
  window.api.hideBar();
  hideModal();
  $('wait').hidden = true;
  $('viewer').hidden = true;
  $('home').hidden = false;
  toast(msg);
}

// ------------------------------------------------------------ controle (lado de quem acessa)
const KEYMAP = (() => {
  const k = {};
  'QWERTYUIOP'.split('').forEach((c, i) => { k['Key' + c] = [0x10 + i, 0]; });
  'ASDFGHJKL'.split('').forEach((c, i) => { k['Key' + c] = [0x1E + i, 0]; });
  'ZXCVBNM'.split('').forEach((c, i) => { k['Key' + c] = [0x2C + i, 0]; });
  for (let i = 1; i <= 9; i++) k['Digit' + i] = [0x01 + i, 0];
  k.Digit0 = [0x0B, 0];
  for (let i = 1; i <= 10; i++) k['F' + i] = [0x3A + i, 0];
  Object.assign(k, {
    F11: [0x57, 0], F12: [0x58, 0],
    Escape: [0x01, 0], Minus: [0x0C, 0], Equal: [0x0D, 0], Backspace: [0x0E, 0], Tab: [0x0F, 0],
    BracketLeft: [0x1A, 0], BracketRight: [0x1B, 0], Enter: [0x1C, 0], ControlLeft: [0x1D, 0],
    Semicolon: [0x27, 0], Quote: [0x28, 0], Backquote: [0x29, 0], ShiftLeft: [0x2A, 0],
    Backslash: [0x2B, 0], IntlBackslash: [0x56, 0], Comma: [0x33, 0], Period: [0x34, 0],
    Slash: [0x35, 0], ShiftRight: [0x36, 0], NumpadMultiply: [0x37, 0], AltLeft: [0x38, 0],
    Space: [0x39, 0], CapsLock: [0x3A, 0], NumLock: [0x45, 0], ScrollLock: [0x46, 0],
    Numpad7: [0x47, 0], Numpad8: [0x48, 0], Numpad9: [0x49, 0], NumpadSubtract: [0x4A, 0],
    Numpad4: [0x4B, 0], Numpad5: [0x4C, 0], Numpad6: [0x4D, 0], NumpadAdd: [0x4E, 0],
    Numpad1: [0x4F, 0], Numpad2: [0x50, 0], Numpad3: [0x51, 0], Numpad0: [0x52, 0],
    NumpadDecimal: [0x53, 0],
    // teclas "estendidas"
    NumpadEnter: [0x1C, 1], ControlRight: [0x1D, 1], NumpadDivide: [0x35, 1], AltRight: [0x38, 1],
    Home: [0x47, 1], ArrowUp: [0x48, 1], PageUp: [0x49, 1], ArrowLeft: [0x4B, 1],
    ArrowRight: [0x4D, 1], End: [0x4F, 1], ArrowDown: [0x50, 1], PageDown: [0x51, 1],
    Insert: [0x52, 1], Delete: [0x53, 1], MetaLeft: [0x5B, 1], MetaRight: [0x5C, 1],
    ContextMenu: [0x5D, 1],
  });
  return k;
})();

const canControl = () => S.phase === 'active' && S.role === 'viewer' && S.control && S.inputOn;

function normPos(e) {
  const v = $('video');
  if (!v.videoWidth) return null;
  const r = v.getBoundingClientRect();
  const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
  const w = v.videoWidth * s;
  const h = v.videoHeight * s;
  const ox = r.left + (r.width - w) / 2;
  const oy = r.top + (r.height - h) / 2;
  const x = Math.min(1, Math.max(0, (e.clientX - ox) / w));
  const y = Math.min(1, Math.max(0, (e.clientY - oy) / h));
  return { x: Math.round(x * 10000), y: Math.round(y * 10000) };
}

function flushMove() {
  S.movePending = false;
  if (S.lastMove && canControl()) sendDC({ t: 'm', x: S.lastMove.x, y: S.lastMove.y });
}

function setupRemoteInput() {
  const el = $('screen');

  el.addEventListener('mousemove', (e) => {
    if (!canControl()) return;
    const p = normPos(e);
    if (!p) return;
    S.lastMove = p;
    if (!S.movePending) { S.movePending = true; requestAnimationFrame(flushMove); }
  });
  el.addEventListener('mousedown', (e) => {
    el.focus();
    if (!canControl()) return;
    e.preventDefault();
    const p = normPos(e);
    if (p) sendDC({ t: 'm', x: p.x, y: p.y });
    sendDC({ t: 'd', b: e.button > 2 ? 0 : e.button });
  });
  el.addEventListener('mouseup', (e) => {
    if (!canControl()) return;
    e.preventDefault();
    sendDC({ t: 'u', b: e.button > 2 ? 0 : e.button });
  });
  el.addEventListener('wheel', (e) => {
    if (!canControl()) return;
    e.preventDefault();
    const mult = e.deltaMode === 1 ? 40 : 1;
    const d = Math.max(-3000, Math.min(3000, Math.round(-e.deltaY * mult * 1.2)));
    if (d) sendDC({ t: 'w', d });
  }, { passive: false });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('mouseenter', () => { S.kbActive = true; });
  el.addEventListener('mouseleave', () => {
    S.kbActive = false;
    if (canControl()) sendDC({ t: 'r' });
  });

  const key = (down) => (e) => {
    if (!canControl() || !S.kbActive) return;
    const k = KEYMAP[e.code];
    if (!k) return;
    e.preventDefault();
    sendDC({ t: 'k', s: k[0], e: k[1], dn: down });
  };
  window.addEventListener('keydown', key(1), true);
  window.addEventListener('keyup', key(0), true);
  window.addEventListener('blur', () => { if (canControl()) sendDC({ t: 'r' }); });
}

// ------------------------------------------------------------ início
async function init() {
  S.cfg = await window.api.getConfig();
  const id = await window.api.getIdentity();
  S.id = id.id; S.token = id.token; S.name = id.name;
  $('myCode').textContent = fmt(S.id);
  $('nameInput').value = S.name;
  $('quality').value = localStorage.getItem('quality') || 'equilibrada';
  $('autostart').checked = await window.api.getAutostart();

  $('copyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(S.id); toast('Código copiado.'); }
    catch (e) { toast('Não foi possível copiar. Selecione o código e copie manualmente.'); }
  });
  $('newBtn').addEventListener('click', async () => {
    if (S.phase !== 'idle') { toast('Encerre a conexão atual antes de trocar o código.'); return; }
    const d = await window.api.newId();
    S.id = d.id; S.token = d.token;
    $('myCode').textContent = fmt(S.id);
    if (S.ws) S.ws.close(); // reconecta já com o código novo
    toast('Novo código gerado.');
  });

  $('remoteCode').addEventListener('input', (e) => {
    e.target.value = fmt(digits(e.target.value).slice(0, 9));
    updateConnectButton();
  });
  $('remoteCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectToRemote(); });
  $('connectBtn').addEventListener('click', connectToRemote);
  $('waitCancel').addEventListener('click', () => endSession(''));

  $('accCtl').addEventListener('click', () => acceptRequest(true));
  $('accView').addEventListener('click', () => acceptRequest(false));
  $('reject').addEventListener('click', rejectRequest);

  $('hostStop').addEventListener('click', () => endSession('Conexão encerrada.'));
  $('endBtn').addEventListener('click', () => endSession('Conexão encerrada.'));
  window.api.onBarDisconnect(() => endSession('Conexão encerrada.'));

  $('ctlBtn').addEventListener('click', () => {
    S.inputOn = !S.inputOn;
    if (!S.inputOn) sendDC({ t: 'r' });
    updateControlButton();
  });
  $('fsBtn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('viewer').requestFullscreen();
  });

  $('nameInput').addEventListener('change', async (e) => {
    const d = await window.api.setName(e.target.value);
    S.name = d.name;
    e.target.value = d.name;
  });
  $('quality').addEventListener('change', (e) => localStorage.setItem('quality', e.target.value));
  $('autostart').addEventListener('change', async (e) => {
    e.target.checked = await window.api.setAutostart(e.target.checked);
  });

  setupRemoteInput();
  connectWS();
}

init();
