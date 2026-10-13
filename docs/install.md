# Install qqdict on macOS

qqdict requires macOS 13 or later, a compatible Codex installation signed in with ChatGPT, a microphone, and internet access.

## Choose the download

Open **Apple menu → About This Mac**:

| Your Mac | Release asset |
| --- | --- |
| Apple M-series chip | [qqdict-0.5.5-mac-arm64.dmg](https://github.com/qwertyu-alex/qqdict/releases/download/v0.5.5/qqdict-0.5.5-mac-arm64.dmg) |
| Intel processor | [qqdict-0.5.5-mac-x64.dmg](https://github.com/qwertyu-alex/qqdict/releases/download/v0.5.5/qqdict-0.5.5-mac-x64.dmg) |

[Browse releases](https://github.com/qwertyu-alex/qqdict/releases). The corresponding ZIP is an alternative to the DMG. Releases include SHA-256 checksums for checking downloaded files.

Open the DMG, drag **qqdict** to **Applications**, then eject the disk image. Open the installed copy from Applications before granting permissions.

## First launch

Version 0.5.5 is a **Developer ID–signed preview**. Apple notarization is still processing; these downloads are not yet notarized, so macOS may block the first launch.

Open **qqdict** from Applications once. If macOS blocks it and you trust the download, go to **System Settings → Privacy & Security**, find the message about qqdict, and choose **Open Anyway**. Confirm the prompt, then complete Setup. This per-app option appears after a blocked launch. You do not need to disable Gatekeeper or remove quarantine metadata.

If macOS reports a damaged app or malware, download the current release again from this repository and check the release’s checksum; do not bypass that message. See [Apple’s explanation of macOS app security](https://support.apple.com/102445).

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

Quit qqdict before replacing the app in Applications. If you are upgrading from an older ad hoc preview, macOS may ask you to grant permissions again for the signed app. Settings and recent history remain in qqdict’s Application Support folder; the monthly journal remains in `~/Dictation/`.

To uninstall, turn off **Open at login** in qqdict Settings, quit the app, and move `qqdict.app` from Applications to the Trash. Your journal is left in place.

## Older unsigned previews

Releases through 0.5.4 are ad hoc signed and unnotarized. Version 0.5.5 adds a Developer ID signature; notarization remains pending. Older previews may also need the per-app **Open Anyway** approval described above. See [Apple’s instructions](https://support.apple.com/102445).
