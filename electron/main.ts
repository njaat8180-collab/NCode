/**
 * NCode — Electron main process.
 *
 * Startup flow:
 *   1. Acquire the single-instance lock (a second launch just focuses the
 *      existing window instead of fighting over the port).
 *   2. Check whether a NCode server is already serving on 127.0.0.1:3000.
 *        - Yes  -> reuse it (no second server, no EADDRINUSE).
 *        - No   -> check whether the port is occupied by something else.
 *                    - Occupied by a non-NCode app -> clear error, quit.
 *                    - Free -> spawn the bundled NCode server as a child
 *                      process and wait until /api/health responds.
 *   3. Open the native BrowserWindow pointing at http://127.0.0.1:3000.
 *
 * The renderer never gets privileged Node access: it talks to the local
 * server over HTTP exactly like the browser build does.
 */
import { app, BrowserWindow, dialog, shell, ipcMain, session } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { shutdownChildBounded, type ShutdownChild } from './desktopShutdown.js';
import { resolvePort } from '../platform/portConfig.js';
import { isTrustedIpcSender } from '../platform/ipcGuard.js';
import { isPermissionAllowed } from './security.js';
import { formatServerDiagnostics } from '../platform/diagnostics.js';
import { installFaultReporter } from '../src/server/faultReporter.js';

/**
 * Hardening: set once the bounded shutdown has finished, so the deferred quit
 * in `before-quit` runs exactly once and cannot loop.
 */
let shutdownComplete = false;

const HOST = '127.0.0.1';

/**
 * Resolve the port exactly the way the server does:
 * process.env.PORT first, then the project's .env file, then 3000.
 */
function readEnvFile(): string | undefined {
  try {
    const fs = require('fs') as typeof import('fs');
    const envPath = path.join(app.getAppPath(), '.env');
    return fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : undefined;
  } catch {
    return undefined;
  }
}

const portConfig = resolvePort({ envPort: process.env.PORT, envFileContents: readEnvFile() });
const PORT_CONFIG_ERROR = portConfig.ok ? null : portConfig.reason || 'PORT must be an integer between 1 and 65535.';
const PORT = portConfig.port;
const APP_URL = `http://${HOST}:${PORT}`;
const READY_TIMEOUT_MS = 45000;

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let ownsServerProcess = false; // true only if THIS instance spawned the server
let appIsQuitting = false;
let serverStartupFailed: string | null = null;
let serverRestartAttempts = 0;
let lastServerErrors: string[] = [];

function installPermissionGuards(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isPermissionAllowed(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => isPermissionAllowed(permission));
}

function assertTrustedIpcSender(event: Electron.IpcMainInvokeEvent): void {
  const trustedOrigins = [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`];
  if (!isTrustedIpcSender({ senderUrl: event.sender.getURL(), frameUrl: event.senderFrame?.url }, trustedOrigins)) {
    throw new Error('Untrusted IPC sender.');
  }
}

  /* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

function log(...args: unknown[]): void {
  console.log('[NCode-ai]', ...args);
}

/* ------------------------------------------------------------------ */
/* Local server management                                             */
/* ------------------------------------------------------------------ */

/** True if the URL belongs to this app's local server. */
function isLocalAppUrl(url: string): boolean {
  return (
    url.startsWith(`${APP_URL}/`) || url === APP_URL ||
    url.startsWith(`http://localhost:${PORT}/`) || url === `http://localhost:${PORT}`
  );
}

/** Fetch helper with a short timeout (main-process fetch). */
async function fetchJson(url: string, timeoutMs = 1500): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Detect an already-running NCode server. /api/settings is the NCode
 * fingerprint: it only responds on a NCode backend.
 */
async function isNCodeRunning(): Promise<boolean> {
  const data = await fetchJson(`${APP_URL}/api/settings`);
  return Boolean(data && data.success === true && data.settings && typeof data.settings.model === 'string');
}

/** True if something (anything) is listening on the app port. */
async function isPortOccupied(): Promise<boolean> {
  const data = await fetchJson(`${APP_URL}/api/health`, 800);
  if (data) return true;
  // The occupant may not speak HTTP on /api/health; do a raw TCP check too.
  return await new Promise<boolean>((resolve) => {
    const net = require('net') as typeof import('net');
    const socket = new net.Socket();
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
    socket.connect(PORT, HOST);
  });
}

/** Resolve the bundled server entry (works dev and packaged). */
function serverEntryPath(): string {
  // __dirname = <app>/dist/electron in dev, <resources>/app.asar/dist/electron when packed.
  return path.join(__dirname, '..', 'server.cjs');
}

/** Spawn the NCode server as a child process (runs as plain Node). */
function startServerProcess(): ChildProcess {
  const entry = serverEntryPath();
  const cwd = app.isPackaged ? os.homedir() : process.cwd();

  const child = spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      // Run the Electron binary as a plain Node runtime for the server child.
      ELECTRON_RUN_AS_NODE: '1',
      // The server watches this PID and exits if the desktop app dies,
      // so no orphaned server is left behind.
      NCode_PARENT_PID: String(process.pid),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  ownsServerProcess = true;

  child.on('error', (error) => {
    serverStartupFailed = `Could not start the NCode server: ${error.message}`;
    log(serverStartupFailed);
  });

  child.stdout!.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log('[server]', line);
    }
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) {
        lastServerErrors = [...lastServerErrors, line.trim().slice(0, 500)].slice(-12);
        console.error('[NCode] [server]', line);
      }
    }
  });

  child.on('exit', (code, signal) => {
    if (!ownsServerProcess) return;
    if (appIsQuitting) return;
    if (serverProcess && serverProcess !== child) return;

    if (!mainWindow) {
      // Startup phase failure (e.g. port stolen between probe and listen).
      serverStartupFailed = `The NCode server exited during startup (code ${code}).`;
      return;
    }

    // The server died while the app was running. Give transient Electron/Node
    // child failures one automatic recovery before interrupting the user.
    log(`server exited unexpectedly (code ${code}, signal ${signal})`);
    serverProcess = null;
    if (serverRestartAttempts < 1 && mainWindow) {
      serverRestartAttempts += 1;
      setTimeout(() => { void restartServerAndReload(); }, 300);
      return;
    }
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'error',
      title: 'NCode',
      message: 'The NCode server stopped unexpectedly.',
      detail: `Exit code: ${code}. The desktop window cannot work without it.${lastServerErrors.length ? `\n\nServer diagnostics:\n${formatServerDiagnostics(lastServerErrors)}` : ''}`,
      buttons: ['Restart NCode', 'Quit'],
      defaultId: 0,
      noLink: true,
    });
    if (choice === 0) {
      restartServerAndReload();
    } else {
      appIsQuitting = true;
      app.quit();
    }
  });

  return child;
}

async function restartServerAndReload(): Promise<void> {
  log('restarting server and reloading window...');
  serverStartupFailed = null;
  serverProcess = startServerProcess();
  const ready = await waitForServer();
  if (ready && mainWindow) {
    serverRestartAttempts = 0;
    lastServerErrors = [];
    mainWindow.loadURL(APP_URL);
  } else {
    showErrorAndQuit(
      'NCode could not restart its local server.',
      serverStartupFailed || 'The server did not become ready in time.'
    );
  }
}

/** Poll /api/health until the server responds or the child dies. */
async function waitForServer(): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverStartupFailed) return false;
    const health = await fetchJson(`${APP_URL}/api/health`, 1000);
    if (health && health.status === 'ok') return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function stopServerProcess(): void {
  if (serverProcess && ownsServerProcess) {
    log('stopping NCode server...');
    try {
      const child = serverProcess;
      // Detach exit handling so quit is not interrupted.
      serverProcess = null;
      ownsServerProcess = false;
      child.removeAllListeners('exit');
      child.kill();
    } catch (err) {
      log('error stopping server:', err);
    }
  }
}

/**
 * Hardening: the shutdown of the spawned server is BOUNDED.
 *
 * `child.kill()` only asks the child to stop. A child that is stuck can ignore
 * it, and Electron would then wait forever for a process that is never going
 * to exit — the window simply refuses to close. This path escalates to a
 * forced kill and, if even that fails, force-exits the app so the user is
 * never left staring at a hung UI.
 */
async function stopServerProcessBounded(): Promise<void> {
  if (!serverProcess || !ownsServerProcess) return;
  const child = serverProcess;
  serverProcess = null;
  ownsServerProcess = false;
  try {
    child.removeAllListeners('exit');
  } catch { /* the child may already be detached */ }
  log('stopping NCode server (bounded shutdown)...');
  const result = await shutdownChildBounded(child as unknown as ShutdownChild, {
    graceMs: 3_000,
    forceMs: 1_500,
    onLog: (message) => log(message),
  });
  if (!result.exited) {
    // The child outlived both windows. Never hang the UI on quit.
    log('server process did not exit in time; forcing application exit');
    app.exit(0);
  }
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

function showErrorAndQuit(title: string, detail: string): void {
  log(`FATAL: ${title} ${detail}`);
  appIsQuitting = true;
  dialog.showErrorBox(title, detail);
  stopServerProcess();
  app.quit();
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png');
}

/* ------------------------------------------------------------------ */
/* Native dialogs (folder picker)                                      */
/* ------------------------------------------------------------------ */

/**
 * Native "Open Project Folder" picker. Returns the chosen absolute path or
 * null when cancelled. The renderer then sets it as the active workspace
 * through the local server API — the main process never touches the
 * workspace itself.
 */
ipcMain.handle('dialog:select-folder', async (event): Promise<string | null> => {
  assertTrustedIpcSender(event);
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: 'Open Project Folder',
    message: 'Choose the project folder NCode should work in',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Small, explicit window-control bridge for the renderer title controls.
ipcMain.handle('window:minimize', (event) => { assertTrustedIpcSender(event); mainWindow?.minimize(); return true; });
ipcMain.handle('window:toggle-maximize', (event) => {
  assertTrustedIpcSender(event);
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('window:is-maximized', (event) => { assertTrustedIpcSender(event); return Boolean(mainWindow?.isMaximized()); });

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'NCode — Local AI Coding Agent',
    backgroundColor: '#0b0e14',
    icon: appIconPath(),
    show: false, // shown on ready-to-show to avoid a white flash
    autoHideMenuBar: true,
    webPreferences: {
      // Hardened renderer: no Node, no remote, isolated context.
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      // Desktop-only bridge for native folder dialogs.
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // NCode starts minimized by default so a background coding workspace
    // does not interrupt the user's current work. The title control can
    // restore and maximize it whenever needed.
    mainWindow?.minimize();
    log('window shown minimized');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log('NCode UI loaded');
  });

  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    log('blocked webview attachment');
  });

  // Keep the app local: block in-window navigation away from the local server.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocalAppUrl(url)) {
      event.preventDefault();
      log('blocked navigation to', url);
    }
  });

  // New windows are never allowed; external http(s) links open in the
  // system browser instead of hijacking the NCode window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocalAppUrl(url) && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(APP_URL);
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another NCode desktop instance is already running.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      log('starting NCode desktop...');
      installPermissionGuards();

      if (PORT_CONFIG_ERROR) {
        showErrorAndQuit(
          'NCode cannot start: invalid PORT.',
          `${PORT_CONFIG_ERROR}\n\nSet PORT in the NCode .env file to an integer from 1 to 65535, then restart.`,
        );
        return;
      }

      if (await isNCodeRunning()) {
        log(`found an existing NCode server on ${APP_URL} — reusing it`);
      } else if (await isPortOccupied()) {
        showErrorAndQuit(
          `NCode cannot start: port ${PORT} is already in use.`,
          `Another application (not NCode) is listening on ${HOST}:${PORT}.\n\nClose that application and start NCode again, or change PORT in the NCode .env file.`
        );
        return;
      } else {
        log(`starting local NCode server (${APP_URL})...`);
        serverProcess = startServerProcess();
        const ready = await waitForServer();
        if (!ready) {
          const nowRunning = await isNCodeRunning();
          if (nowRunning) {
            log('another NCode instance won the port race — reusing its server');
          } else {
            showErrorAndQuit(
              'NCode could not start its local server.',
              serverStartupFailed ||
                `The server did not respond on ${APP_URL} within ${READY_TIMEOUT_MS / 1000} seconds.\n\nCheck the console output for details.`
            );
            return;
          }
        } else {
          log('server ready');
        }
      }

      createWindow();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    } catch (err: any) {
      showErrorAndQuit('NCode failed to start.', err?.message || String(err));
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    appIsQuitting = true;
    // Hardening: the first quit is deferred until the bounded shutdown of the
    // server has finished. Without this the app would exit while the child
    // server is still alive (leaving an orphaned process holding the port),
    // or hang waiting for a child that never dies.
    if (shutdownComplete) return;
    event.preventDefault();
    void stopServerProcessBounded().finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });

  // Raw signals (Ctrl+C in a terminal, `kill`) do not run Electron's normal
  // quit sequence on every platform — stop the server explicitly here too.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      appIsQuitting = true;
      void stopServerProcessBounded().finally(() => {
        shutdownComplete = true;
        app.quit();
      });
    });
  }
}

installFaultReporter({
  label: '[NCode] [electron]',
  onFatalError: async () => {
    appIsQuitting = true;
    await stopServerProcessBounded();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  },
  fatalCleanupTimeoutMs: 2500,
});
