export type Hotkey = 'fn' | 'right-option' | 'ctrl-option';
export type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'error';
export type Permission = 'granted' | 'denied' | 'not-determined' | 'unavailable';
export type TranscriptEntry = {
  id: string;
  text: string;
  timestamp: string;
  pasted: boolean;
  error?: string;
  logError?: string;
};
export type Settings = { hotkey: Hotkey; microphoneId: string; launchAtLogin: boolean };
export type AppState = {
  phase: Phase;
  connected: boolean;
  label: string;
  detail: string;
  hotkey: Hotkey;
  microphoneId: string;
  launchAtLogin: boolean;
  permissions: { microphone: Permission; accessibility: Permission; inputMonitoring: Permission };
  history: TranscriptEntry[];
  logDirectory: string;
  level: number;
  elapsedSeconds: number;
  maxRecordingSeconds: number;
};
export type AppEvent =
  | { type: 'state'; state: AppState }
  | { type: 'navigate'; tab: 'setup' | 'settings' }
  | { type: 'command'; command: 'start' | 'stop' | 'cancel'; takeId: number }
  | { type: 'status' | 'partial' | 'final' | 'error'; text?: string; status?: string; detail?: string; takeId?: number };
export interface DictationAPI {
  getState(): Promise<AppState>;
  refresh(): Promise<AppState>;
  setSettings(settings: Partial<Settings>): Promise<AppState>;
  requestPermission(kind: keyof AppState['permissions']): Promise<AppState>;
  openSettings(kind: keyof AppState['permissions']): Promise<void>;
  begin(): Promise<void>;
  end(): Promise<void>;
  copyTranscript(id: string): Promise<void>;
  holdOverlay(held: boolean): void;
  beginOverlayDrag(): void;
  moveOverlayDrag(): void;
  endOverlayDrag(): void;
  openLogs(): Promise<void>;
  showSettings(): Promise<void>;
  quit(): Promise<void>;
  ready(): Promise<void>;
  reportLevel(level: number): void;
  reportError(message: string, takeId: number): void;
  start(takeId: number): Promise<void>;
  sendAudio(audio: ArrayBuffer, takeId: number): void;
  stop(takeId: number): Promise<void>;
  cancel(takeId: number): Promise<void>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
