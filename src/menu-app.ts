import { app, autoUpdater, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, powerMonitor, screen, session, shell, systemPreferences, Tray, type WebContents } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
import { CodexHarness } from './harness';
import { DictationTransport, safeMessage, type DictationEvent } from './transport';
import { MacBridge, type FocusTarget } from './native';
import { DictationStore } from './store';
import { pasteTranscript } from './paste';
import { nearestIslandAnchor, positionForAnchor } from './island-position';
import { migrateLegacyHistory } from './storage';
import { BUILD_IDENTITY, PRODUCT_NAME, PRODUCT_VERSION, PRODUCT_REPOSITORY } from './product';
import { AppUpdater, updateAvailability } from './updates';
import type { AppEvent, AppState, Settings, TranscriptEntry } from './contracts';

app.setName(PRODUCT_NAME);
app.setPath('userData', path.join(app.getPath('appData'), PRODUCT_NAME));
let setup: BrowserWindow | null = null;
let recorder: BrowserWindow | null = null;
let popover: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: DictationStore;
let bridge: MacBridge;
let updates: AppUpdater | undefined;
let quitting = false;
let screenLocked = false;
let suspended = false;
let pendingSettings = 0;
let recorderReady = false;
let nextTakeId = 1;
let fadeTimer: ReturnType<typeof setTimeout> | null = null;
let overlayHovered = false;
type OverlayDrag = { cursor: Electron.Point; bounds: Electron.Rectangle; moved: boolean };
let overlayDrag: OverlayDrag | null = null;
const harness = new CodexHarness();
type Take = { id: number; manual: boolean; target: FocusTarget; focusReady: Promise<void>; stopRequested: boolean; commandStarted: boolean; startedAt: number; finishing?: Promise<void>; partial: string; abort: AbortController };
let take: Take | null = null;
const pendingFinalizations = new Set<Promise<void>>();
const state: AppState = {
  phase: 'idle', connected: false, label: 'Checking Codex sign-in…', detail: '',
  hotkey: 'fn', microphoneId: '', microphoneName: '', launchAtLogin: false,
  permissions: { microphone: 'not-determined', accessibility: 'not-determined', inputMonitoring: 'not-determined' },
  history: [], logDirectory: path.join(os.homedir(), BUILD_IDENTITY.journalDirectory),
  level: 0, elapsedSeconds: 0, maxRecordingSeconds: 300,
};
const transport = new DictationTransport(harness, handleTransport);

function surfaces(): BrowserWindow[] { return [setup, recorder, popover, overlay].filter((w): w is BrowserWindow => !!w && !w.isDestroyed()); }
function send(event: AppEvent): void { for (const window of surfaces()) window.webContents.send('dictation:event', event); }
function snapshot(): AppState { return { ...state, permissions: { ...state.permissions }, history: store?.history ?? [] }; }
function publish(): void {
  if (quitting) return;
  // The nonactivating panel accepts dragging in every phase without taking typing focus.
  send({ type: 'state', state: snapshot() }); updateTray();
  updates?.activityChanged();
}
function validSender(contents: WebContents): boolean { return surfaces().some((window) => window.webContents === contents); }
function requireRecorder(contents: WebContents, id: number): Take {
  if (contents !== recorder?.webContents || take?.id !== id) throw new Error('This recording is no longer active.');
  return take;
}

function icon(phase: AppState['phase']): Electron.NativeImage {
  const scaleFactor = 2, size = 22 * scaleFactor;
  const data = Buffer.alloc(size * size * 4);
  const spinning = phase === 'transcribing' || phase === 'starting';
  const heights = phase === 'recording' ? [7, 15, 11, 17, 7] : [5, 11, 17, 11, 5];
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) {
    const x = (column + .5) / scaleFactor, y = (row + .5) / scaleFactor;
    let distance = Infinity;
    if (spinning) {
      if (!(x > 13 && y < 8)) distance = Math.abs(Math.hypot(x - 11, y - 11) - 6.85) - 1.15;
    } else {
      heights.forEach((height, index) => {
        // A capsule gives each waveform bar round ends at both display scales.
        const radius = 1.25, center = 4.5 + index * 3.25;
        const dy = Math.max(0, Math.abs(y - 11) - (height / 2 - radius));
        distance = Math.min(distance, Math.hypot(x - center, dy) - radius);
      });
    }
    data[(row * size + column) * 4 + 3] = Math.round(Math.max(0, Math.min(1, .5 - distance * scaleFactor)) * 255);
  }
  const image = nativeImage.createFromBitmap(data, { width: size, height: size, scaleFactor });
  image.setTemplateImage(true);
  return image;
}

function updateTray(): void {
  if (!tray || tray.isDestroyed()) return;
  tray?.setImage(icon(state.phase));
  const updateHint = updates?.status.phase === 'ready' ? ' · Update ready (right-click to restart)' : '';
  tray?.setToolTip(`${PRODUCT_NAME} · ${state.phase === 'idle' ? 'Hold ' + state.hotkey + ' to dictate' : state.phase}${updateHint}`);
  tray?.setTitle(state.phase === 'recording' ? '•' : state.phase === 'transcribing' ? '…' : '');
}

function showOverlay(): void {
  if (!overlay) return;
  if (fadeTimer) clearTimeout(fadeTimer);
  fadeTimer = null;
  if (!overlay.isVisible()) overlayHovered = false;
  if (!overlayDrag) positionOverlay();
  overlay.showInactive();
  const point = screen.getCursorScreenPoint(), bounds = overlay.getBounds();
  overlayHovered = point.x >= bounds.x + 16 && point.x <= bounds.x + bounds.width - 16
    && point.y >= bounds.y + 16 && point.y <= bounds.y + bounds.height - 16;
  updateOverlayMouseInput();
}

function updateOverlayMouseInput(): void {
  // Mouse motion reaches Chromium for hover detection, while the transparent
  // shadow margins let clicks through to the writing app.
  overlay?.setIgnoreMouseEvents(!overlayHovered && !overlayDrag, { forward: true });
}

function positionOverlay(): void {
  if (!overlay || overlay.isDestroyed()) return;
  const placement = store.islandPlacement;
  const display = screen.getAllDisplays().find(item => item.id === placement.displayId)
    ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const point = positionForAnchor(display.workArea, overlay.getBounds(), placement.anchor);
  overlay.setPosition(point.x, point.y);
}

function startOverlayDrag(): void {
  if (!overlay?.isVisible() || overlayDrag) return;
  overlayDrag = { cursor: screen.getCursorScreenPoint(), bounds: overlay.getBounds(), moved: false };
  updateOverlayMouseInput();
  if (fadeTimer) clearTimeout(fadeTimer);
  fadeTimer = null;
}

function moveOverlayDrag(): void {
  if (!overlayDrag || !overlay || overlay.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const dx = cursor.x - overlayDrag.cursor.x, dy = cursor.y - overlayDrag.cursor.y;
  if (!overlayDrag.moved && Math.hypot(dx, dy) < 4) return;
  overlayDrag.moved = true;
  overlay.setPosition(Math.round(overlayDrag.bounds.x + dx), Math.round(overlayDrag.bounds.y + dy));
}

function endOverlayDrag(): void {
  if (!overlayDrag) return;
  moveOverlayDrag();
  const moved = overlayDrag.moved;
  overlayDrag = null;
  updateOverlayMouseInput();
  if (moved && overlay && !overlay.isDestroyed()) {
    const bounds = overlay.getBounds();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const anchor = nearestIslandAnchor(display.workArea, bounds, bounds);
    const point = positionForAnchor(display.workArea, bounds, anchor);
    overlay.setPosition(point.x, point.y);
    // Placement uses its own store action, so dragging never changes the global shortcut.
    void store.updateIslandPlacement({ anchor, displayId: display.id }).catch(() => {
      console.error('Could not save the island position.');
    });
  }
  if (!take && overlay?.isVisible()) dismissOverlay(1500);
  updates?.activityChanged();
}

function dismissOverlay(delay = 4000): void {
  if (fadeTimer) clearTimeout(fadeTimer);
  fadeTimer = null;
  if (overlayHovered || overlayDrag) return;
  fadeTimer = setTimeout(() => { if (!take && !overlayHovered && !overlayDrag) overlay?.hide(); fadeTimer = null; }, delay);
}

function showSetup(): void {
  setup?.show(); setup?.focus(); popover?.hide();
  const ready = state.connected && Object.values(state.permissions).every(permission => permission === 'granted');
  setup?.webContents.send('dictation:event', { type: 'navigate', tab: ready ? 'settings' : 'setup' } satisfies AppEvent);
}

function togglePopover(): void {
  if (!popover || !tray) return;
  if (popover.isVisible()) { popover.hide(); return; }
  const button = tray.getBounds();
  const area = screen.getDisplayMatching(button).workArea;
  const width = popover.getBounds().width;
  popover.setPosition(Math.round(Math.max(area.x, Math.min(button.x + button.width / 2 - width / 2, area.x + area.width - width))), Math.max(area.y, button.y + button.height + 4));
  popover.show(); popover.focus(); publish();
}

async function refreshPermissions(): Promise<void> {
  const mic = systemPreferences.getMediaAccessStatus('microphone');
  state.permissions.microphone = mic === 'granted' ? 'granted' : mic === 'not-determined' ? 'not-determined' : 'denied';
  try {
    const permissions = await bridge.request<{ inputMonitoring: boolean; accessibility: boolean; eventTapActive: boolean }>('status');
    state.permissions.inputMonitoring = permissions.inputMonitoring ? (permissions.eventTapActive ? 'granted' : 'unavailable') : 'denied';
    state.permissions.accessibility = permissions.accessibility ? 'granted' : 'denied';
  } catch {
    state.permissions.inputMonitoring = 'unavailable'; state.permissions.accessibility = 'unavailable';
  }
  publish();
}

async function refreshConnection(): Promise<void> {
  const status = await transport.status();
  state.connected = status.connected; state.label = status.label;
  if (!take) state.detail = status.detail ?? '';
  publish();
}

async function begin(manual: boolean): Promise<void> {
  if (quitting || updates?.restartPending || take || !recorderReady) return;
  if (!state.connected || state.permissions.microphone !== 'granted') {
    state.detail = !state.connected ? 'Open Codex and sign in with ChatGPT, then reconnect here.' : 'Allow microphone access in setup before dictating.';
    state.phase = 'error'; publish(); showSetup(); return;
  }
  const current: Take = { id: nextTakeId++, manual, target: {}, focusReady: Promise.resolve(), stopRequested: false, commandStarted: false, startedAt: Date.now(), partial: '', abort: new AbortController() };
  take = current;
  state.phase = 'starting'; state.detail = 'Opening microphone…'; state.elapsedSeconds = 0; state.level = 0; state.microphoneName = '';
  // Focus metadata is needed only when pasting. Never hold up capture for AX.
  if (!manual) {
    current.focusReady = bridge.captureFocus().then((target) => {
      if (take === current) current.target = target;
      else if (target.focusId) void bridge.request('discardFocus', { focusId: target.focusId }).catch(() => {});
    }).catch(() => { /* Dictation remains recoverable in history. */ });
  }
  current.commandStarted = true;
  recorder!.webContents.send('dictation:event', { type: 'command', command: 'start', takeId: current.id } satisfies AppEvent);
  popover?.hide(); publish(); showOverlay();
}

function end(): void {
  if (!take || take.finishing || take.stopRequested) return;
  take.stopRequested = true;
  state.phase = 'transcribing'; state.detail = 'Transcribing…'; state.level = 0; publish();
  if (take.commandStarted) recorder?.webContents.send('dictation:event', { type: 'command', command: 'stop', takeId: take.id } satisfies AppEvent);
}

function cancel(): void {
  const current = take;
  take = null;
  if (current) {
    current.abort.abort();
    recorder?.webContents.send('dictation:event', { type: 'command', command: 'cancel', takeId: current.id } satisfies AppEvent);
    if (current.target.focusId) void bridge.request('discardFocus', { focusId: current.target.focusId }).catch(() => {});
  }
  transport.cancel();
  state.phase = 'idle'; state.detail = 'Cancelled'; state.level = 0; publish(); dismissOverlay(500);
}

function fail(message: string): void {
  const current = take;
  if (!current) return;
  current.abort.abort();
  take = null;
  recorder?.webContents.send('dictation:event', { type: 'command', command: 'cancel', takeId: current.id } satisfies AppEvent);
  transport.cancel();
  if (current.target.focusId) void bridge.request('discardFocus', { focusId: current.target.focusId }).catch(() => {});
  state.phase = 'error'; state.detail = safeMessage(message); state.level = 0; publish(); showOverlay(); dismissOverlay(6000);
}

function finalize(text: string, current: Take): Promise<void> {
  if (current.finishing) return current.finishing;
  current.finishing = (async () => {
    if (take !== current) return;
    state.phase = 'transcribing'; state.detail = 'Saving transcript…'; state.level = 0; publish();
    if (!text.trim()) {
      if (current.target.focusId) void bridge.request('discardFocus', { focusId: current.target.focusId }).catch(() => {});
      state.detail = 'No speech detected.'; take = null; state.phase = 'idle'; publish(); dismissOverlay(); return;
    }
    let entry: TranscriptEntry | undefined;
    let historyWriteFailed = false;
    const previousId = store.history[0]?.id;
    try { entry = await store.addTranscript(text); }
    catch {
      const latest = store.history[0];
      if (latest?.id !== previousId && latest?.text === text) entry = latest;
      historyWriteFailed = true;
    }
    if (!entry) throw new Error('The transcript could not be saved. Copy the displayed transcript before quitting.');
    if (!entry || take !== current) return;
    if (!current.manual) {
      try {
        await current.focusReady;
        if (take !== current) return;
        await pasteTranscript(bridge, text, current.target, current.abort.signal);
        if (take !== current) return;
        await store.updateTranscript(entry.id, { pasted: true }).catch(() => { historyWriteFailed = true; });
        if (take !== current) return;
        state.detail = entry.logError ? 'Pasted. The monthly log could not be written.' : 'Pasted';
      } catch (error) {
        if (take !== current) return;
        const message = safeMessage(error);
        await store.updateTranscript(entry.id, { pasted: false, error: message }).catch(() => {});
        if (take !== current) return;
        state.detail = 'Saved to history. ' + message;
      }
    } else state.detail = entry.logError ? 'Transcript ready. The monthly log could not be written.' : 'Transcript ready';
    if (historyWriteFailed) state.detail += ' Recent-history storage needs attention.';
    if (current.target.focusId) void bridge.request('discardFocus', { focusId: current.target.focusId }).catch(() => {});
    if (take !== current) return;
    take = null; state.phase = entry.logError ? 'error' : 'idle'; publish(); dismissOverlay(6000);
  })().catch((error) => { if (take === current) fail(safeMessage(error)); }).finally(() => {
    pendingFinalizations.delete(current.finishing!);
    updates?.activityChanged();
  });
  // cancel() and fail() clear `take` before asynchronous save/paste cleanup has
  // settled. Updates must wait for that cleanup, including clipboard restore.
  pendingFinalizations.add(current.finishing);
  return current.finishing;
}

function handleTransport(event: DictationEvent): void {
  const current = take;
  if (!current) return;
  if (current.finishing) return;
  recorder?.webContents.send('dictation:event', { ...event, takeId: current.id } satisfies AppEvent);
  if (event.type === 'partial') current.partial = event.text ?? '';
  else if (event.type === 'final') void finalize(event.text ?? '', current);
  else if (event.type === 'error') fail(event.text ?? 'Dictation failed.');
}

function createSurface(options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  const window = new BrowserWindow({ ...options, webPreferences: {
    preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    ...options.webPreferences,
  } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  return window;
}

function updateMenuItem(): Electron.MenuItemConstructorOptions {
  return { id: 'check-for-updates', ...updates!.menuItem, click: () => updates?.check(true) };
}

function updateBusy(): boolean {
  return !!take || pendingFinalizations.size > 0 || pendingSettings > 0 || !!overlayDrag || screenLocked || suspended;
}

async function initializeUpdates(): Promise<void> {
  let configuration: unknown;
  if (app.isPackaged && BUILD_IDENTITY.channel === 'production') {
    try { configuration = JSON.parse(await readFile(path.join(process.resourcesPath, 'update-config.json'), 'utf8')); }
    catch { /* Older or locally packaged apps remain on manual downloads. */ }
  }
  updates = new AppUpdater({
    availability: updateAvailability({
      isPackaged: app.isPackaged, channel: BUILD_IDENTITY.channel, platform: process.platform, arch: process.arch,
      version: app.getVersion(), bundleId: BUILD_IDENTITY.bundleId,
      inApplicationsFolder: app.isPackaged && app.isInApplicationsFolder(), configuration,
    }),
    updater: autoUpdater,
    isBusy: updateBusy,
    prepareInstall: () => store.flush(),
    showMessage: async (options) => {
      popover?.hide();
      const result = setup && !setup.isDestroyed() && setup.isVisible()
        ? await dialog.showMessageBox(setup, options) : await dialog.showMessageBox(options);
      return result.response;
    },
    onChange: () => {
      if (updates?.status.phase === 'ready') quitting = false;
      const item = Menu.getApplicationMenu()?.getMenuItemById('check-for-updates');
      if (item) Object.assign(item, updates!.menuItem);
      updateTray();
    },
  });
}

async function initialize(): Promise<void> {
  const migrated = BUILD_IDENTITY.channel === 'production'
    && await migrateLegacyHistory(app.getPath('userData'), path.join(app.getPath('appData'), 'Codex Dictation'));
  store = new DictationStore({ dataDirectory: app.getPath('userData'), logDirectory: state.logDirectory });
  await store.load();
  if (app.isPackaged) {
    if (migrated) app.setLoginItemSettings({ openAtLogin: store.settings.launchAtLogin });
    else if (store.settings.launchAtLogin !== app.getLoginItemSettings().openAtLogin) {
      // Reflect changes made in macOS Login Items instead of silently re-enabling them.
      await store.updateSettings({ launchAtLogin: app.getLoginItemSettings().openAtLogin });
    }
  }
  Object.assign(state, store.settings);
  const binary = app.isPackaged ? path.join(process.resourcesPath, 'native', 'DictationBridge') : path.join(__dirname, '..', 'native', 'build', 'DictationBridge');
  bridge = new MacBridge(binary);
  bridge.on('permissions', () => { void refreshPermissions(); });
  bridge.on('hotkey', (event) => { if (event.phase === 'down') void begin(false); else if (event.phase === 'up') end(); });
  bridge.on('cancel', cancel);
  bridge.start();
  await bridge.setHotkey(state.hotkey).catch(() => {});
  app.dock?.hide();
  const area = screen.getPrimaryDisplay().workArea;
  setup = createSurface({ width: 460, height: Math.min(590, area.height - 40), minWidth: 420, minHeight: 540, show: false, title: PRODUCT_NAME, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 }, backgroundColor: '#212121' });
  recorder = createSurface({ width: 1, height: 1, show: false, focusable: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  popover = createSurface({ width: 392, height: Math.min(550, area.height - 40), show: false, frame: false, transparent: true, hasShadow: false, resizable: false, skipTaskbar: true, title: `${PRODUCT_NAME} · Recent`, backgroundColor: '#00000000' });
  overlay = createSurface({ width: 312, height: 76, show: false, type: 'panel', frame: false, transparent: true, focusable: false, acceptFirstMouse: true, resizable: false, hasShadow: false, alwaysOnTop: true, skipTaskbar: true });
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); overlay.setAlwaysOnTop(true, 'floating');
  updateOverlayMouseInput();
  const adjustOverlay = () => { overlayDrag = null; positionOverlay(); updateOverlayMouseInput(); if (!take && overlay?.isVisible()) dismissOverlay(); };
  screen.on('display-added', adjustOverlay);
  screen.on('display-removed', adjustOverlay);
  screen.on('display-metrics-changed', adjustOverlay);
  setup.on('close', (event) => { if (!quitting) { event.preventDefault(); setup?.hide(); } });
  popover.on('blur', () => popover?.hide());
  setup.on('focus', () => { void refreshPermissions(); });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === recorder?.webContents && permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => (contents === recorder?.webContents || contents === setup?.webContents) && permission === 'media');
  const rendererDir = path.join(__dirname, 'renderer');
  bindIPC();
  await Promise.all([
    setup.loadFile(path.join(rendererDir, 'index.html')),
    recorder.loadFile(path.join(rendererDir, 'index.html'), { query: { recorder: '1' } }),
    popover.loadFile(path.join(rendererDir, 'popover.html')),
    overlay.loadFile(path.join(rendererDir, 'overlay.html')),
  ]);
  tray = new Tray(icon('idle')); tray.on('click', togglePopover); updateTray();
  await Promise.all([refreshPermissions(), refreshConnection()]);
  await initializeUpdates();
  tray.on('right-click', () => tray?.popUpContextMenu(Menu.buildFromTemplate([
    { label: 'Settings…', click: showSetup }, { type: 'separator' }, updateMenuItem(),
    { type: 'separator' }, { label: `Quit ${PRODUCT_NAME}`, click: () => app.quit() },
  ])));
  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME, applicationVersion: PRODUCT_VERSION,
    copyright: '© 2026 qqdict contributors', credits: 'Push-to-talk dictation for macOS.',
    iconPath: path.join(__dirname, '..', 'assets', app.isPackaged ? 'app-icon.png' : BUILD_IDENTITY.iconSource), website: PRODUCT_REPOSITORY });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: PRODUCT_NAME, submenu: [{ role: 'about', label: `About ${PRODUCT_NAME}` },
      updateMenuItem(),
      { type: 'separator' }, { label: 'Settings…', accelerator: 'CommandOrControl+,', click: showSetup },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide', label: `Hide ${PRODUCT_NAME}` },
      { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: `Quit ${PRODUCT_NAME}` }] },
    { role: 'editMenu' }, { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'qqdict on GitHub', click: () => { void shell.openExternal(PRODUCT_REPOSITORY); } },
      { label: 'Release notes and downloads…', click: () => { void shell.openExternal(`${PRODUCT_REPOSITORY}/releases`); } }] },
  ]));
  updates!.start();
  if (!app.getLoginItemSettings().wasOpenedAtLogin || Object.values(state.permissions).some((permission) => permission !== 'granted') || !state.connected) showSetup();
  setInterval(() => { if (take && !take.stopRequested) { state.elapsedSeconds = Math.min(300, Math.floor((Date.now() - take.startedAt) / 1000)); if (state.elapsedSeconds >= 300) end(); publish(); } }, 250).unref();
  powerMonitor.on('suspend', () => { suspended = true; cancel(); });
  powerMonitor.on('lock-screen', () => { screenLocked = true; cancel(); });
  powerMonitor.on('unlock-screen', () => { screenLocked = false; updates?.activityChanged(); });
  powerMonitor.on('resume', () => { suspended = false; void refreshPermissions(); updates?.check(); updates?.activityChanged(); });
}

function bindIPC(): void {
  const handle = (name: string, callback: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any) => {
    ipcMain.handle('dictation:' + name, (event, ...args) => { if (!validSender(event.sender)) throw new Error('Invalid app surface.'); return callback(event, ...args); });
  };
  handle('state', () => snapshot());
  handle('refresh', async () => {
    bridge.start();
    await bridge.setHotkey(state.hotkey).catch(() => {});
    await refreshPermissions();
    if (!take) await refreshConnection();
    return snapshot();
  });
  handle('ready', (event) => { if (event.sender === recorder?.webContents) recorderReady = true; publish(); });
  handle('settings', async (_event, settings: Partial<Settings>) => {
    if (updates?.restartPending) throw new Error('qqdict is preparing to restart. Change settings after the update.');
    if (take) throw new Error('Finish the current dictation before changing settings.');
    pendingSettings++;
    try {
      await store.updateSettings(settings); Object.assign(state, store.settings);
      await bridge.setHotkey(state.hotkey);
      if ('launchAtLogin' in settings && app.isPackaged) app.setLoginItemSettings({ openAtLogin: state.launchAtLogin });
      publish(); return snapshot();
    } finally {
      pendingSettings--;
      updates?.activityChanged();
    }
  });
  handle('permission', async (_event, kind: keyof AppState['permissions']) => {
    if (kind === 'microphone') await systemPreferences.askForMediaAccess('microphone');
    else if (kind === 'accessibility') await bridge.request('requestAccessibility');
    else if (kind === 'inputMonitoring') await bridge.request('requestInputMonitoring');
    else throw new Error('Unknown permission.');
    await refreshPermissions(); return snapshot();
  });
  handle('open-permission-settings', async (_event, kind: keyof AppState['permissions']) => {
    if (!['microphone', 'accessibility', 'inputMonitoring'].includes(kind)) return;
    // Register the helper with macOS before showing the permission pane. These
    // requests are triggered only by the user's explicit permission button.
    if (kind === 'accessibility') await bridge.request('requestAccessibility');
    if (kind === 'inputMonitoring') await bridge.request('requestInputMonitoring');
    await bridge.request('openSettings', { pane: kind });
  });
  handle('begin', () => begin(true)); handle('end', end);
  handle('start', async (event, id: number) => { requireRecorder(event.sender, id); await transport.start(); });
  handle('stop', async (event, id: number) => { const current = requireRecorder(event.sender, id); const text = await transport.stop(); await finalize(text, current); });
  handle('cancel', (event, id: number) => { if (event.sender === recorder?.webContents && take?.id === id && !take.finishing) cancel(); });
  handle('copy', (event, id: string) => {
    if (event.sender === overlay?.webContents && take) throw new Error('Wait for the current transcript to finish.');
    const entry = store.history.find((entry) => entry.id === id);
    if (!entry) throw new Error('This transcript is no longer available.');
    clipboard.writeText(entry.text);
    if (event.sender === overlay?.webContents) dismissOverlay(2000);
  });
  handle('logs', async () => { await mkdir(state.logDirectory, { recursive: true }); await shell.openPath(state.logDirectory); });
  handle('show-settings', showSetup); handle('quit', () => app.quit());
  ipcMain.on('dictation:overlay-hover', (event, held: unknown) => {
    if (event.sender !== overlay?.webContents || typeof held !== 'boolean') return;
    overlayHovered = held;
    updateOverlayMouseInput();
    if (held) { if (fadeTimer) clearTimeout(fadeTimer); fadeTimer = null; }
    else if (!take && overlay?.isVisible()) dismissOverlay(1500);
  });
  ipcMain.on('dictation:overlay-drag-start', event => { if (event.sender === overlay?.webContents) startOverlayDrag(); });
  ipcMain.on('dictation:overlay-drag-move', event => { if (event.sender === overlay?.webContents) moveOverlayDrag(); });
  ipcMain.on('dictation:overlay-drag-end', event => { if (event.sender === overlay?.webContents) endOverlayDrag(); });
  ipcMain.on('dictation:capturing', (event, id: number, microphoneName: unknown) => {
    if (event.sender !== recorder?.webContents || take?.id !== id || take.stopRequested || take.finishing) return;
    state.microphoneName = typeof microphoneName === 'string' ? microphoneName.trim().slice(0, 120) : '';
    state.phase = 'recording'; state.detail = 'Listening'; publish();
  });
  ipcMain.on('dictation:audio', (event, audio: unknown, id: number) => { if (event.sender === recorder?.webContents && take?.id === id && audio instanceof ArrayBuffer) transport.append(audio); });
  ipcMain.on('dictation:level', (event, level: number) => { if (event.sender === recorder?.webContents && take && Number.isFinite(level)) { state.level = Math.max(0, Math.min(1, level)); publish(); } });
  ipcMain.on('dictation:recorder-error', (event, message: string, id: number) => { if (event.sender === recorder?.webContents && take?.id === id && typeof message === 'string') fail(safeMessage(message)); });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showSetup);
  app.on('activate', showSetup);
  app.whenReady().then(initialize).catch((error) => { console.error('qqdict could not start:', safeMessage(error)); app.quit(); });
}
// quitAndInstall closes windows before Electron emits app.before-quit. Mark
// quitting early so the Settings close handler cannot veto the update.
autoUpdater.on('before-quit-for-update', () => { quitting = true; });
app.on('before-quit', () => {
  quitting = true;
  updates?.dispose();
  take?.abort.abort(); take = null;
  transport.cancel(); harness.dispose(); bridge?.dispose();
  tray?.destroy(); tray = null;
});
app.on('window-all-closed', () => {});
