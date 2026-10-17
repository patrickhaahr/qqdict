import type { AutoUpdater, MessageBoxOptions } from 'electron';
import type { EventEmitter } from 'node:events';

export const UPDATE_STARTUP_DELAY_MS = 15_000;
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

type UpdateAvailability = { feedURL: string; reason?: never } | { feedURL?: never; reason: string };
type Build = {
  isPackaged: boolean; channel: string; platform: string; arch: string;
  version: string; bundleId: string; inApplicationsFolder: boolean; configuration: unknown;
};

/** Only installed, notarized production builds may consume the stable feed. */
export function updateAvailability(build: Build): UpdateAvailability {
  if (build.channel !== 'production') return { reason: 'Nightly builds do not receive production updates. Install qqdict from GitHub Releases to receive stable updates.' };
  if (!build.isPackaged) return { reason: 'Automatic updates are available in the installed qqdict app. Source builds do not update themselves.' };
  if (build.platform !== 'darwin' || !['arm64', 'x64'].includes(build.arch)) return { reason: 'Automatic updates require an Apple Silicon or Intel Mac.' };
  const configuration = build.configuration as Record<string, unknown> | null;
  if (!configuration || configuration.enabled !== true || configuration.version !== build.version
    || configuration.arch !== build.arch || configuration.bundleId !== build.bundleId) {
    return { reason: 'This build is not configured for automatic updates. Install a signed, notarized production release from GitHub Releases.' };
  }
  if (!build.inApplicationsFolder) return { reason: 'Move qqdict to Applications, quit it, and open it from there to enable automatic updates.' };
  if (!/^\d+\.\d+\.\d+$/.test(build.version)) return { reason: 'Preview versions do not receive stable updates. Install a production release from GitHub Releases.' };
  return { feedURL: `https://update.electronjs.org/qwertyu-alex/qqdict/darwin-${build.arch}/${build.version}` };
}

type Phase = 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'waiting' | 'installing' | 'error';
type Status = { phase: Phase; releaseName?: string };
type Options = {
  availability: UpdateAvailability;
  updater: Pick<AutoUpdater, 'setFeedURL' | 'checkForUpdates' | 'quitAndInstall'> & Pick<EventEmitter, 'on' | 'removeListener'>;
  isBusy(): boolean;
  prepareInstall(): Promise<void>;
  showMessage(options: MessageBoxOptions): Promise<number>;
  onChange(): void;
};

/** Electron owns downloading, signature verification, and replacing the bundle. */
export class AppUpdater {
  private current: Status;
  private started = false;
  private disposed = false;
  private manualCheck = false;
  private prompted = false;
  private dialogOpen = false;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;

  constructor(private readonly options: Options) {
    this.current = { phase: options.availability.feedURL ? 'idle' : 'disabled' };
  }

  get status(): Readonly<Status> { return { ...this.current }; }
  get restartPending(): boolean { return this.current.phase === 'waiting' || this.current.phase === 'installing'; }
  get menuItem(): { label: string; enabled: boolean } {
    switch (this.current.phase) {
      case 'checking': return { label: 'Checking for updates…', enabled: false };
      case 'downloading': return { label: 'Downloading update…', enabled: false };
      case 'ready': return { label: 'Restart to update…', enabled: true };
      case 'waiting': return { label: 'Restarting after dictation…', enabled: false };
      case 'installing': return { label: 'Restarting…', enabled: false };
      default: return { label: 'Check for updates…', enabled: true };
    }
  }

  start(): void {
    if (this.started || this.disposed || !this.options.availability.feedURL) return;
    this.started = true;
    const updater = this.options.updater;
    updater.on('error', this.onError);
    updater.on('update-available', this.onAvailable);
    updater.on('update-not-available', this.onNotAvailable);
    updater.on('update-downloaded', this.onDownloaded);
    this.startupTimer = setTimeout(() => this.check(), UPDATE_STARTUP_DELAY_MS);
    this.interval = setInterval(() => this.check(), UPDATE_CHECK_INTERVAL_MS);
    this.startupTimer.unref();
    this.interval.unref();
  }

  check(manual = false): void {
    if (this.disposed) return;
    if (!this.options.availability.feedURL) {
      if (manual) this.inform('Automatic updates are unavailable', this.options.availability.reason!);
      return;
    }
    if (this.current.phase === 'ready') {
      if (manual) this.requestInstall();
      return;
    }
    if (this.restartPending) return;
    // Electron starts a second download if checkForUpdates is called twice.
    this.manualCheck ||= manual;
    if (this.current.phase === 'checking' || this.current.phase === 'downloading') return;
    this.setStatus({ phase: 'checking' });
    try {
      this.options.updater.setFeedURL({ url: this.options.availability.feedURL });
      this.options.updater.checkForUpdates();
    } catch {
      this.onError();
    }
  }

  /** Called after dictation, cancelled paste cleanup, or an island drag settles. */
  activityChanged(): void {
    if (this.disposed || this.options.isBusy()) return;
    if (this.current.phase === 'waiting') void this.install();
    else if (this.current.phase === 'ready' && !this.prompted) void this.prompt();
  }

  requestInstall(): void {
    if (this.disposed || !['ready', 'waiting'].includes(this.current.phase)) return;
    this.prompted = true;
    if (this.options.isBusy()) this.setStatus({ ...this.current, phase: 'waiting' });
    else void this.install();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.startupTimer);
    clearInterval(this.interval);
    const updater = this.options.updater;
    updater.removeListener('update-available', this.onAvailable);
    updater.removeListener('update-not-available', this.onNotAvailable);
    updater.removeListener('update-downloaded', this.onDownloaded);
    // Keep the guarded error listener until exit: a native download may still
    // report an error while the application is shutting down.
  }

  private setStatus(status: Status): void {
    this.current = status;
    this.options.onChange();
  }

  private readonly onAvailable = (): void => {
    if (!this.disposed) this.setStatus({ phase: 'downloading' });
  };

  private readonly onNotAvailable = (): void => {
    if (this.disposed) return;
    const manual = this.manualCheck;
    this.manualCheck = false;
    this.setStatus({ phase: 'idle' });
    if (manual) this.inform('qqdict is up to date', 'You already have the latest stable release.');
  };

  private readonly onDownloaded = (_event: unknown, _notes: string, releaseName: string): void => {
    if (this.disposed) return;
    this.manualCheck = false;
    this.prompted = false;
    this.setStatus({ phase: 'ready', releaseName });
    this.activityChanged();
  };

  private readonly onError = (): void => {
    if (this.disposed) return;
    if (this.current.phase === 'installing') {
      this.setStatus({ ...this.current, phase: 'ready' });
      this.inform('Couldn’t install the update', 'Try Restart to update again, or download the latest qqdict release from GitHub.', 'error');
      return;
    }
    const manual = this.manualCheck;
    this.manualCheck = false;
    this.setStatus({ phase: 'error' });
    // An offline Mac or a temporary service error must not interrupt dictation.
    if (manual) this.inform('Couldn’t check for updates', 'Check your internet connection and try again. You can also download qqdict from GitHub Releases.', 'error');
  };

  private inform(message: string, detail: string, type: 'info' | 'error' = 'info'): void {
    void this.options.showMessage({ type, title: 'qqdict updates', message, detail, buttons: ['OK'] }).catch(() => {});
  }

  private async prompt(): Promise<void> {
    if (this.dialogOpen || this.disposed) return;
    this.dialogOpen = true;
    this.prompted = true;
    try {
      const response = await this.options.showMessage({
        type: 'info', title: 'qqdict update', message: 'An update is ready',
        detail: `${this.current.releaseName || 'A new version of qqdict'} has been downloaded. Restart to install it, or choose Later to apply it the next time qqdict starts.`,
        buttons: ['Restart now', 'Later'], defaultId: 1, cancelId: 1,
      });
      // The user may have started another take while the dialog was open.
      if (response === 0 && !this.disposed) this.requestInstall();
    } catch { /* The menu still offers Restart to update. */ }
    finally { this.dialogOpen = false; }
  }

  private async install(): Promise<void> {
    if (this.disposed || this.current.phase === 'installing') return;
    this.setStatus({ ...this.current, phase: 'installing' });
    try {
      // Also retry the history cache if its last write failed. Never restart
      // with a transcript available only in memory.
      await this.options.prepareInstall();
      if (this.disposed) return;
      if (this.options.isBusy()) { this.setStatus({ ...this.current, phase: 'waiting' }); return; }
      this.options.updater.quitAndInstall();
    } catch {
      if (this.disposed) return;
      this.setStatus({ ...this.current, phase: 'ready' });
      this.inform('Couldn’t restart to update', 'qqdict stayed open. Make sure your transcript history can be saved and try Restart to update again.', 'error');
    }
  }
}
