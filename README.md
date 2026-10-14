<img src="assets/app-icon.png" width="96" alt="qqdict waveform icon">

# qqdict

Hold a key. Say it. Keep writing.

qqdict is a small macOS menu bar app that turns your voice into text and pastes it into the field you’re using. It uses your existing Codex sign-in.

**[Download qqdict for Mac →](https://github.com/qwertyu-alex/qqdict/releases/tag/v0.5.5)**

[Apple Silicon](https://github.com/qwertyu-alex/qqdict/releases/download/v0.5.5/qqdict-0.5.5-mac-arm64.dmg) · [Intel](https://github.com/qwertyu-alex/qqdict/releases/download/v0.5.5/qqdict-0.5.5-mac-x64.dmg) · [All releases](https://github.com/qwertyu-alex/qqdict/releases)

Choose **Apple Silicon** (`arm64`) for an M-series Mac or **Intel** (`x64`) for an Intel Mac. Requires **macOS 13 or later**, a microphone, internet access, and a compatible Codex installation signed in with ChatGPT.

Both Mac downloads are signed with Developer ID and notarized by Apple. See [installation and first launch](docs/install.md).

> The transcription connection uses an internal Codex protocol; it may change or stop working and is not a supported public subscription API. qqdict is an independent project, unaffiliated with OpenAI.

<p>
  <a href="assets/screenshots/settings.png"><img src="assets/screenshots/settings.png" width="368" alt="qqdict Settings, with shortcut, microphone, journal, and dictation controls"></a>
  <a href="assets/screenshots/popover.png"><img src="assets/screenshots/popover.png" width="314" alt="qqdict menu bar popover showing recent example transcripts with copy buttons"></a>
</p>

<p>
  <a href="assets/screenshots/island-recording.png"><img src="assets/screenshots/island-recording.png" width="312" alt="Floating dictation island while recording, with a waveform and timer"></a>
  <a href="assets/screenshots/island-saved.png"><img src="assets/screenshots/island-saved.png" width="312" alt="Floating dictation island after a transcript is saved, with its quick-copy button"></a>
</p>

Interface previews with example transcripts. Click any image to view it at full resolution.

## Install

1. Download the `.dmg` for your Mac from [Releases](https://github.com/qwertyu-alex/qqdict/releases).
2. Open it and drag **qqdict** into **Applications**.
3. Open qqdict from **Applications** and complete the **Setup** tab: Codex sign-in, Microphone, Accessibility, and Input Monitoring.
4. Click a text field, hold **fn / Globe**, speak, and release to paste.

macOS may ask you to confirm opening an app downloaded from the internet on first launch. qqdict lives in the menu bar; its window can be closed while dictation stays available.

<details>
  <summary>See the Setup tab</summary>

  <p><a href="assets/screenshots/setup.png"><img src="assets/screenshots/setup.png" width="460" alt="qqdict Setup tab, with progress and access steps for Codex, Microphone, Accessibility, and Input Monitoring"></a></p>
</details>

## Small by design

- **Push to talk:** hold fn / Globe to record; release to transcribe. Right Option and Control + Option are available in Settings.
- **Paste where you write:** qqdict inserts into the originally focused field. If focus changes or the field is protected, your transcript stays available to copy.
- **Recent transcripts:** click the menu bar icon to recover and copy your last 10 dictations.
- **Floating island:** shows recording and transcription status, with one-click copy of the latest transcript. Drag it to any corner or the center of any screen edge; it remembers the position.
- **Markdown journal:** every completed transcript is appended with a timestamp to `~/Dictation/YYYY-MM.md`.
- **Your preferences:** choose a microphone and optionally open qqdict at login.

Recording stops on release and is limited to five minutes per take. The menu bar icon shows idle, recording, and transcribing states.

## What is sent and saved

Audio is streamed to the ChatGPT dictation service through your existing Codex authentication. This is **cloud transcription**, so it requires internet access. qqdict does not save audio files or store your Codex credential in its settings or transcript journal.

Transcripts are saved as plain text in `~/Dictation/` and in the app’s local recent-history cache. Treat the journal like any other document containing what you dictated. The app does not add analytics or a separate account service.

Accessibility enables paste into the focused app; Input Monitoring detects the selected modifier shortcut. The native helper observes modifier changes and focus metadata, rather than typed text or field contents. During automatic paste it temporarily preserves the clipboard and restores it unless you copy something else in the meantime. A manual **Copy** intentionally replaces the clipboard.

## Build from source

Use a Mac with **Node.js 22.12 or later**, **pnpm 10.9.0**, and the **Xcode Command Line Tools** installed. The `packageManager` field pins pnpm; `pnpm-lock.yaml` pins dependencies. Install pnpm through [Corepack](https://pnpm.io/10.x/installation#using-corepack) (`corepack enable pnpm`) to include the native dependency build tools.

```sh
git clone https://github.com/qwertyu-alex/qqdict.git
cd qqdict
pnpm install --frozen-lockfile
pnpm test
pnpm run start
```

`pnpm run start` builds the Swift helper and TypeScript app, then launches Electron. For reliable macOS permission registration, use a packaged app:

```sh
pnpm run package:mac
open release/qqdict.app
```

Create a drag-to-Applications installer and a ZIP:

```sh
pnpm run dist:mac
```

Each build targets the architecture of the installed Electron runtime. Separate Apple Silicon and Intel builds are produced by the release workflow; this is not a universal binary. See [release and signing instructions](docs/releasing.md) and the [native bridge notes](native/README.md).

## Help and development

[Troubleshooting](docs/troubleshooting.md) covers permissions, fn behavior, microphone selection, and missing paste results. Report problems through [GitHub Issues](https://github.com/qwertyu-alex/qqdict/issues), including your macOS version, Mac architecture, qqdict version, and what happened. Omit transcripts, account tokens, and other private data.

qqdict currently supports **macOS only**. The app is written in TypeScript with Electron; a small Swift helper handles the global shortcut and safe paste. Contributions are welcome.

## License

[MIT](LICENSE).
