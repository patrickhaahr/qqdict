# Install qqdict on macOS

qqdict requires macOS 13 or later, a compatible Codex installation signed in with ChatGPT, a microphone, and internet access.

## Choose the download

Open **Apple menu → About This Mac**:

| Your Mac | Release asset |
| --- | --- |
| Apple M-series chip | [qqdict-0.5.2-mac-arm64.dmg](https://github.com/qwertyu-alex/qqdict/releases/download/v0.5.2/qqdict-0.5.2-mac-arm64.dmg) |
| Intel processor | [qqdict-0.5.2-mac-x64.dmg](https://github.com/qwertyu-alex/qqdict/releases/download/v0.5.2/qqdict-0.5.2-mac-x64.dmg) |

[Browse releases](https://github.com/qwertyu-alex/qqdict/releases). The corresponding ZIP is an alternative to the DMG. Releases include SHA-256 checksums for checking downloaded files.

Open the DMG, drag **qqdict** to **Applications**, then eject the disk image. Open the installed copy from Applications before granting permissions.

## First launch of an unnotarized preview

Preview builds are ad hoc signed. That verifies the app’s local code structure, but it does not establish an Apple Developer identity or notarization. macOS may block the first launch of a downloaded preview.

If you trust the source of the download, attempt to open qqdict once, then go to **System Settings → Privacy & Security**. Find the message about qqdict and choose **Open Anyway**, then confirm the macOS prompt. The option appears only after a blocked launch. Use this per-app approval rather than disabling Gatekeeper or removing quarantine metadata.

If macOS reports malware, a damaged app, or no available approval, stop and check that you downloaded the expected release. Do not bypass that message. See [Apple’s guide to opening a blocked app](https://support.apple.com/102445).

## Complete Setup

The Setup tab shows four steps:

| Step | What it enables |
| --- | --- |
| Codex | Finds your existing ChatGPT sign-in through the installed Codex harness. qqdict does not ask for an API key. |
| Microphone | Records your voice while the shortcut is held. |
| Accessibility | Pastes the transcript into the field you were using. |
| Input Monitoring | Detects the selected shortcut while another app has focus. |

Follow each action in Setup. macOS may ask for Touch ID or your password to change privacy permissions. After changing Accessibility or Input Monitoring, quit qqdict from its menu bar menu and reopen the installed app if Setup has not updated.

Click a text field, hold **fn / Globe**, speak, then release. The island shows progress; the text is saved to your journal even if automatic paste is unavailable. Click the island’s copy button or the menu bar icon to recover it.

If fn also opens the emoji picker or macOS dictation, open **System Settings → Keyboard** and set **Press fn / Globe key to** to **Do Nothing**, or choose another shortcut in qqdict Settings. qqdict does not change this setting for you.

## Update or remove

If you used the earlier **Codex Dictation** app, qqdict imports its recent history and preferences automatically on first launch. Turn off **Open at login** in the old app and quit it so both apps do not run together. Your existing `~/Dictation/` journal stays in place.

Quit qqdict before replacing the app in Applications. Ad hoc builds can require macOS permission approval again after an update. Settings and recent history remain in qqdict’s Application Support folder; the monthly journal remains in `~/Dictation/`.

To uninstall, turn off **Open at login** in qqdict Settings, quit the app, and move `qqdict.app` from Applications to the Trash. Your journal is left in place.
