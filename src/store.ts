import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Hotkey, Settings, TranscriptEntry } from './contracts';
import { isIslandAnchor, type IslandAnchor } from './island-position';

const DEFAULT_SETTINGS: Settings = { hotkey: 'fn', microphoneId: '', launchAtLogin: false };
const HOTKEYS: Hotkey[] = ['fn', 'right-option', 'ctrl-option'];
const HISTORY_LIMIT = 10;

type StoreOptions = { dataDirectory: string; logDirectory: string; timeZone?: string };
type TranscriptOptions = { pasted?: boolean; error?: string; now?: Date };
type TranscriptUpdate = Pick<Partial<TranscriptEntry>, 'pasted' | 'error' | 'logError'>;
export type IslandPlacement = { anchor: IslandAnchor; displayId?: number };
type SavedState = { version: 1; settings: Settings; history: TranscriptEntry[]; islandPlacement: IslandPlacement };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isIslandPlacement(value: unknown): value is IslandPlacement {
  return isObject(value) && isIslandAnchor(value.anchor)
    && (value.displayId === undefined || (Number.isSafeInteger(value.displayId) && typeof value.displayId === 'number'));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateSettings(partial: Partial<Settings>): void {
  if (!isObject(partial)) throw new TypeError('Settings must be an object.');
  if ('hotkey' in partial && !HOTKEYS.includes(partial.hotkey as Hotkey)) {
    throw new TypeError('Choose fn, right-option, or ctrl-option for the hotkey.');
  }
  if ('microphoneId' in partial && typeof partial.microphoneId !== 'string') {
    throw new TypeError('The microphone ID must be a string.');
  }
  if ('launchAtLogin' in partial && typeof partial.launchAtLogin !== 'boolean') {
    throw new TypeError('Launch at login must be true or false.');
  }
}

function validateTranscriptUpdate(partial: TranscriptUpdate): void {
  if (!isObject(partial)) throw new TypeError('Transcript updates must be an object.');
  if ('pasted' in partial && typeof partial.pasted !== 'boolean') {
    throw new TypeError('The pasted status must be true or false.');
  }
  if (!isOptionalString(partial.error) || !isOptionalString(partial.logError)) {
    throw new TypeError('Transcript errors must be strings.');
  }
}

function isTranscript(value: unknown): value is TranscriptEntry {
  return isObject(value)
    && typeof value.id === 'string' && !!value.id
    && typeof value.text === 'string' && !!value.text.trim()
    && typeof value.timestamp === 'string' && Number.isFinite(Date.parse(value.timestamp))
    && typeof value.pasted === 'boolean'
    && isOptionalString(value.error) && isOptionalString(value.logError);
}

function copyTranscript(entry: TranscriptEntry): TranscriptEntry {
  return {
    id: entry.id, text: entry.text, timestamp: entry.timestamp, pasted: entry.pasted,
    ...(entry.error === undefined ? {} : { error: entry.error }),
    ...(entry.logError === undefined ? {} : { logError: entry.logError }),
  };
}

/** Stores text only. Audio and authentication never enter the history or log. */
export class DictationStore {
  private readonly historyFile: string;
  private readonly dataDirectory: string;
  private readonly logDirectory: string;
  private readonly timeZone: string;
  private readonly dateFormatter: Intl.DateTimeFormat;
  private savedSettings: Settings = { ...DEFAULT_SETTINGS };
  private savedHistory: TranscriptEntry[] = [];
  private savedIslandPlacement: IslandPlacement = { anchor: 'bottom-center' };
  private writeQueue: Promise<void> = Promise.resolve();
  private loaded = false;
  private preservationError?: Error;

  constructor({ dataDirectory, logDirectory, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone }: StoreOptions) {
    this.dataDirectory = dataDirectory;
    this.logDirectory = logDirectory;
    this.historyFile = path.join(dataDirectory, 'history.json');
    this.timeZone = timeZone;
    this.dateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', timeZoneName: 'longOffset',
    });
  }

  get settings(): Settings { return { ...this.savedSettings }; }
  get history(): TranscriptEntry[] { return this.savedHistory.map(copyTranscript); }
  get islandPlacement(): IslandPlacement { return { ...this.savedIslandPlacement }; }

  /** Drain pending writes and persist in-memory recovery before an update. */
  flush(): Promise<void> {
    return this.enqueue(() => this.saveCache());
  }

  load(): Promise<void> {
    return this.enqueue(async () => {
      if (this.loaded) return;
      let raw: string;
      try {
        raw = await readFile(this.historyFile, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.loaded = true; return; }
        throw error;
      }

      let valid = true;
      let value: unknown;
      try { value = JSON.parse(raw); } catch { valid = false; }
      if (!isObject(value)) {
        valid = false;
      } else {
        if (value.version !== 1 || !isObject(value.settings) || !Array.isArray(value.history)) valid = false;
        if (isObject(value.settings)) {
          const settings = value.settings;
          if (HOTKEYS.includes(settings.hotkey as Hotkey)) this.savedSettings.hotkey = settings.hotkey as Hotkey;
          else valid = false;
          if (typeof settings.microphoneId === 'string') this.savedSettings.microphoneId = settings.microphoneId;
          else valid = false;
          if (typeof settings.launchAtLogin === 'boolean') this.savedSettings.launchAtLogin = settings.launchAtLogin;
          else valid = false;
        }
        // Older caches have no placement. Add the default without treating them as damaged.
        if ('islandPlacement' in value) {
          if (isIslandPlacement(value.islandPlacement)) this.savedIslandPlacement = {
            anchor: value.islandPlacement.anchor,
            ...(value.islandPlacement.displayId === undefined ? {} : { displayId: value.islandPlacement.displayId }),
          };
          else valid = false;
        }
        if (Array.isArray(value.history)) {
          const ids = new Set<string>();
          const recovered: TranscriptEntry[] = [];
          for (const entry of value.history) {
            if (isTranscript(entry) && !ids.has(entry.id)) {
              ids.add(entry.id);
              recovered.push(copyTranscript(entry));
            } else valid = false;
          }
          this.savedHistory = recovered.slice(0, HISTORY_LIMIT);
        }
      }

      if (!valid) {
        // Preserve the exact original before any future atomic save replaces it.
        const backup = path.join(this.dataDirectory, `history.corrupt-${randomUUID()}.json`);
        try {
          await copyFile(this.historyFile, backup, constants.COPYFILE_EXCL);
          this.preservationError = undefined;
        } catch (error) {
          this.preservationError = new Error(`Could not preserve unreadable history: ${errorMessage(error)}`);
          throw this.preservationError;
        }
      }
      this.loaded = true;
    });
  }

  updateSettings(partial: Partial<Settings>): Promise<void> {
    return this.enqueue(async () => {
      this.assertLoaded();
      validateSettings(partial);
      // Copy only supported fields; never persist arbitrary values from IPC.
      this.savedSettings = {
        hotkey: partial.hotkey ?? this.savedSettings.hotkey,
        microphoneId: partial.microphoneId ?? this.savedSettings.microphoneId,
        launchAtLogin: partial.launchAtLogin ?? this.savedSettings.launchAtLogin,
      };
      await this.saveCache();
    });
  }

  updateIslandPlacement(placement: IslandPlacement): Promise<void> {
    return this.enqueue(async () => {
      this.assertLoaded();
      if (!isIslandPlacement(placement)) throw new TypeError('Choose a valid island position and display.');
      this.savedIslandPlacement = {
        anchor: placement.anchor,
        ...(placement.displayId === undefined ? {} : { displayId: placement.displayId }),
      };
      await this.saveCache();
    });
  }

  addTranscript(text: string, { pasted = false, error, now = new Date() }: TranscriptOptions = {}): Promise<TranscriptEntry> {
    return this.enqueue(async () => {
      this.assertLoaded();
      if (typeof text !== 'string' || !text.trim()) throw new TypeError('Cannot save an empty transcript.');
      validateTranscriptUpdate({ pasted, error });
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('The transcript date is invalid.');
      const entry: TranscriptEntry = {
        id: randomUUID(), text, timestamp: now.toISOString(), pasted,
        ...(error === undefined ? {} : { error }),
      };
      try {
        await this.appendLog(text, now);
      } catch (logError) {
        entry.logError = errorMessage(logError);
      }
      this.savedHistory = [entry, ...this.savedHistory].slice(0, HISTORY_LIMIT);
      // Keep the entry in memory if writing the cache fails, so the UI can still recover it.
      await this.saveCache();
      return copyTranscript(entry);
    });
  }

  updateTranscript(id: string, partial: TranscriptUpdate): Promise<TranscriptEntry | undefined> {
    return this.enqueue(async () => {
      this.assertLoaded();
      validateTranscriptUpdate(partial);
      const entry = this.savedHistory.find(item => item.id === id);
      if (!entry) return undefined;
      if ('pasted' in partial) entry.pasted = partial.pasted!;
      if ('error' in partial) {
        if (partial.error === undefined) delete entry.error;
        else entry.error = partial.error;
      }
      if ('logError' in partial) {
        if (partial.logError === undefined) delete entry.logError;
        else entry.logError = partial.logError;
      }
      await this.saveCache();
      return copyTranscript(entry);
    });
  }

  private assertLoaded(): void {
    if (this.preservationError) throw this.preservationError;
    if (!this.loaded) throw new Error('Load dictation history before using the store.');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async appendLog(text: string, now: Date): Promise<void> {
    const parts = Object.fromEntries(this.dateFormatter.formatToParts(now).map(part => [part.type, part.value]));
    const month = `${parts.year}-${parts.month}`;
    const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace(/^GMT/, '');
    const timestamp = `${month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${offset}`;
    await mkdir(this.logDirectory, { recursive: true, mode: 0o700 });
    await appendFile(path.join(this.logDirectory, `${month}.md`), `\n## ${timestamp} (${this.timeZone})\n\n${text}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private async saveCache(): Promise<void> {
    this.assertLoaded();
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${this.historyFile}.tmp-${process.pid}-${randomUUID()}`;
    const state: SavedState = { version: 1, settings: this.settings, history: this.history, islandPlacement: this.islandPlacement };
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.historyFile);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
