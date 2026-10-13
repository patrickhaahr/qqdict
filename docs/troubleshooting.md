# Troubleshooting

## Setup cannot find Codex

Open Codex and sign in with ChatGPT, then click **Refresh** in qqdict Setup. API-key-only sign-in is not supported by this backend. A Codex or workspace configuration that disables dictation is respected.

qqdict depends on an internal authentication and dictation protocol. A newer Codex build, subscription restriction, or managed workspace can prevent connection. Updating qqdict may help; access to the route is not guaranteed. Never paste a token into an issue report.

The current backend was verified with **Codex `0.162.0-alpha.17.2`**. Protocol compatibility is not guaranteed across Codex versions.

For development, `CODEX_BINARY` can point to a compatible Codex executable if your installation is in an unusual location.

## Moving from Codex Dictation

qqdict automatically imports your previous recent history and preferences when its own history cache does not yet exist. Your monthly journal stays in `~/Dictation/`.

Turn off **Open at login** in the old Codex Dictation app, then quit it before opening qqdict. This prevents both apps from running and listening for the same shortcut. Set **Open at login** in qqdict to the behavior you want.

## Holding fn does nothing

Check **Input Monitoring** in Setup and **System Settings → Privacy & Security**. Enable the installed copy of qqdict, then quit and reopen it. If you rebuilt or updated an ad hoc app, macOS may retain a permission registration for the previous build.

Choose **Right Option** or **Control + Option** in Settings to test another shortcut. Some keyboards do not expose fn / Globe in the same way as an Apple keyboard.

## fn opens emoji or macOS dictation

In **System Settings → Keyboard**, set **Press fn / Globe key to** to **Do Nothing** or use a different qqdict shortcut. Accessibility also allows the helper to suppress fn’s usual action. qqdict does not alter the system keyboard preference.

## The wrong microphone is selected

Choose your audio input in Settings. **Default** follows macOS’s current default microphone. Reconnect a missing device or select a different one; a disconnected device cannot record. Confirm Microphone access in Setup.

## The transcript is saved but not pasted

Use **Copy** in the island, recent menu, or History tab. Confirm Accessibility access, and start dictation with a text field already focused. Keep that same field focused until transcription finishes, and release modifier keys before the result arrives.

qqdict skips automatic paste if focus changes, the field is protected, or the app does not expose a suitable editable field. Some custom editors provide too little accessibility information. The Settings window’s recording test saves a transcript for review rather than pasting into another app.

## The connection closes or reaches a limit

Check your internet connection and retry a short take. The backend can reject an account, enforce a usage limit, or change its protocol. qqdict stops each take after five minutes and waits up to 30 seconds for a final result after release.

## The journal cannot be written

Open the journal folder from qqdict Settings and check that `~/Dictation/` is writable and your disk has space. Your latest transcript remains available in History when possible. Copy it before quitting if the app reports that local storage failed.

## The island appears on another display

Drag it to the display and edge you prefer. It snaps to the nearest corner or edge midpoint and remembers the display. If that display is disconnected, qqdict places it on an available screen.

## Reporting a problem

[Create a GitHub issue](https://github.com/qwertyu-alex/qqdict/issues) with the qqdict version, macOS version, whether your Mac is Apple Silicon or Intel, and a short description of the steps. Redact screenshots and logs that include transcripts, clipboard contents, authentication tokens, or account details.
