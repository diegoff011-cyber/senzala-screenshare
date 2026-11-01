// Senzala Screenshare - processo principal
const {
  app, BrowserWindow, ipcMain, desktopCapturer, session, screen, Tray, Menu, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Para testar duas cópias no mesmo PC: defina SENZALA_DEV=2 (ou qualquer valor)
const DEV = process.env.SENZALA_DEV;
if (DEV) app.setPath('userData', path.join(app.getPath('userData'), 'dev-' + DEV));

if (!DEV && !app.requestSingleInstanceLock()) {
  app.quit();
}

const ICON = path.join(__dirname, 'assets', 'icon.png');
let win = null;
let barWin = null;
let tray = null;
let quitting = false;

// ---------------------------------------------------------------- identidade
const identityFile = () => path.join(app.getPath('userData'), 'identity.json');

function newCode() {
  return String(crypto.randomInt(100000000, 1000000000));
}

function loadIdentity() {
  try {
    const d = JSON.parse(fs.readFileSync(identityFile(), 'utf8'));
    if (/^\d{9}$/.test(d.id) && typeof d.token === 'string' && d.token.length >= 16) return d;
  } catch (e) { /* primeira vez */ }
  const d = {
    id: newCode(),
    token: crypto.randomBytes(16).toString('hex'),
    name: os.hostname().slice(0, 30),
  };
  saveIdentity(d);
  return d;
}

function saveIdentity(d) {
  fs.mkdirSync(path.dirname(identityFile()), { recursive: true });
  fs.writeFileSync(identityFile(), JSON.stringify(d));
}

ipcMain.handle('identity:get', () => loadIdentity());
ipcMain.handle('identity:setName', (_e, name) => {
  const d = loadIdentity();
  d.name = String(name || '').trim().slice(0, 30) || os.hostname().slice(0, 30);
  saveIdentity(d);
  return d;
});
ipcMain.handle('identity:newId', () => {
  const d = loadIdentity();
  d.id = newCode();
  d.token = crypto.randomBytes(16).toString('hex');
  saveIdentity(d);
  return d;
});

ipcMain.handle('config:get', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  return { servidor: cfg.servidor, platform: process.platform };
});

// ------------------------------------------------------------ iniciar com Windows
ipcMain.handle('autostart:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('autostart:set', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  return app.getLoginItemSettings().openAtLogin;
});

// ------------------------------------------------------------ captura de tela
// Sempre captura a tela principal (é nela que o mouse remoto vai atuar).
function setupCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const primaryId = String(screen.getPrimaryDisplay().id);
      const src = sources.find((s) => s.display_id === primaryId) || sources[0];
      callback({ video: src });
    } catch (e) {
      callback({});
    }
  });
}

// ------------------------------------------------------ mouse e teclado (Windows)
// Um pequeno programa em PowerShell/C# fica rodando e recebe comandos linha a linha.
const HELPER_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class Z {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct IU { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public IU u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] i, int size);

  static uint[] DOWN = new uint[] { 0x0002, 0x0020, 0x0008 };
  static uint[] UP   = new uint[] { 0x0004, 0x0040, 0x0010 };
  static bool[] btn = new bool[3];
  static HashSet<string> keys = new HashSet<string>();

  static void Mouse(uint flags, int dx, int dy, uint data) {
    INPUT[] a = new INPUT[1];
    a[0].type = 0;
    a[0].u.mi.dx = dx;
    a[0].u.mi.dy = dy;
    a[0].u.mi.mouseData = data;
    a[0].u.mi.dwFlags = flags;
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }

  static void Key(int sc, bool ext, bool down) {
    INPUT[] a = new INPUT[1];
    uint f = 0x0008;
    if (ext) f |= 0x0001;
    if (!down) f |= 0x0002;
    a[0].type = 1;
    a[0].u.ki.wScan = (ushort)sc;
    a[0].u.ki.dwFlags = f;
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }

  static void ReleaseAll() {
    for (int b = 0; b < 3; b++) { if (btn[b]) { Mouse(UP[b], 0, 0, 0); btn[b] = false; } }
    foreach (string k in keys) {
      string[] p = k.Split(':');
      Key(int.Parse(p[0]), p[1] == "1", false);
    }
    keys.Clear();
  }

  public static void Run() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      try {
        string[] p = line.Trim().Split(' ');
        switch (p[0]) {
          case "M": {
            int x = int.Parse(p[1]) * 65535 / 10000;
            int y = int.Parse(p[2]) * 65535 / 10000;
            Mouse(0x8001, x, y, 0);
            break;
          }
          case "D": { int b = int.Parse(p[1]); btn[b] = true; Mouse(DOWN[b], 0, 0, 0); break; }
          case "U": { int b = int.Parse(p[1]); btn[b] = false; Mouse(UP[b], 0, 0, 0); break; }
          case "W": { int d = int.Parse(p[1]); Mouse(0x0800, 0, 0, unchecked((uint)d)); break; }
          case "K": {
            int sc = int.Parse(p[1]);
            bool ext = p[2] == "1";
            bool down = p[3] == "1";
            string id = sc + ":" + (ext ? "1" : "0");
            if (down) keys.Add(id); else keys.Remove(id);
            Key(sc, ext, down);
            break;
          }
          case "R": ReleaseAll(); break;
        }
      } catch (Exception) { }
    }
    ReleaseAll();
  }
}
'@
[Z]::Run()
`;

let helper = null;

function startHelper() {
  if (process.platform !== 'win32') return false;
  if (helper) return true;
  const file = path.join(os.tmpdir(), 'senzala-input-helper.ps1');
  fs.writeFileSync(file, HELPER_PS1, 'utf8');
  helper = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
  );
  helper.on('exit', () => { helper = null; });
  helper.on('error', () => { helper = null; });
  helper.stdin.on('error', () => {});
  return true;
}

function stopHelper() {
  if (!helper) return;
  try {
    helper.stdin.write('R\n');
    helper.stdin.end();
  } catch (e) { /* já fechou */ }
  const h = helper;
  setTimeout(() => { try { h.kill(); } catch (e) { /* ok */ } }, 1500);
  helper = null;
}

const INPUT_LINE = /^(M \d{1,5} \d{1,5}|[DU] [012]|W -?\d{1,5}|K \d{1,3} [01] [01]|R)$/;

ipcMain.handle('input:start', () => startHelper());
ipcMain.on('input:send', (_e, line) => {
  if (!helper || typeof line !== 'string' || !INPUT_LINE.test(line)) return;
  try { helper.stdin.write(line + '\n'); } catch (e) { /* ignora */ }
});
ipcMain.on('input:stop', () => stopHelper());

// ------------------------------------------------- barra "alguém está conectado"
ipcMain.on('bar:show', (_e, info) => {
  if (barWin) { barWin.close(); barWin = null; }
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  barWin = new BrowserWindow({
    width: 460, height: 52, x: Math.round((width - 460) / 2), y: 8,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    maximizable: false, minimizable: false, backgroundColor: '#0a0a0a', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
    },
  });
  barWin.setAlwaysOnTop(true, 'screen-saver');
  barWin.loadFile(path.join(__dirname, 'renderer', 'bar.html'), {
    query: { name: String((info && info.name) || 'Alguém'), control: info && info.control ? '1' : '0' },
  });
  barWin.once('ready-to-show', () => barWin && barWin.showInactive());
  barWin.on('closed', () => { barWin = null; });
});
ipcMain.on('bar:hide', () => { if (barWin) { barWin.close(); barWin = null; } });
ipcMain.on('bar:disconnect', () => { if (win) win.webContents.send('bar:disconnect'); });

// Chama a atenção quando chega um pedido de acesso
ipcMain.on('win:attention', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.flashFrame(true);
  win.setAlwaysOnTop(true);
  setTimeout(() => { if (win) win.setAlwaysOnTop(false); }, 1500);
});

// -------------------------------------------------------------------- janela
function createWindow(hidden) {
  win = new BrowserWindow({
    width: 1000, height: 660, minWidth: 820, minHeight: 560,
    backgroundColor: '#0a0a0a', autoHideMenuBar: true, icon: ICON, show: !hidden,
    title: 'Senzala Screenshare',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); } // fica na bandeja para receber pedidos
  });
}

function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Senzala Screenshare');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir', click: () => { win.show(); win.focus(); } },
    { label: 'Sair', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { win.show(); win.focus(); });
}

app.on('second-instance', () => {
  if (win) { win.show(); win.focus(); }
});

app.whenReady().then(() => {
  setupCapture();
  createWindow(process.argv.includes('--hidden'));
  createTray();
});

app.on('before-quit', () => { quitting = true; stopHelper(); });
app.on('window-all-closed', () => { /* continua na bandeja */ });
