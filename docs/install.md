# Install qqdict on macOS

qqdict requires macOS 13 or later, a compatible Codex installation signed in with ChatGPT, a microphone, and internet access.

## Choose the download

Open **Apple menu → About This Mac**:

| Your Mac | Release asset |
| --- | --- |
| Apple M-series chip | [qqdict-0.5.6-mac-arm64.dmg](https://github.com/qwertyu-alex/qqdict/releases/download/v0.5.6/qqdict-0.5.6-mac-arm64.dmg) |
| Intel processor | [qqdict-0.5.6-mac-x64.dmg](https://github.com/qwertyu-alex/qqdict/releases/download/v0.5.6/qqdict-0.5.6-mac-x64.dmg) |

[Browse releases](https://github.com/qwertyu-alex/qqdict/releases). The corresponding ZIP is an alternative to the DMG. Releases include SHA-256 checksums for checking downloaded files.

Open the DMG, drag **qqdict** to **Applications**, then eject the disk image. Open the installed copy from Applications before granting permissions.

## First launch

The current version 0.5.6 downloads are **signed with Developer ID and notarized by Apple**.

Open **qqdict** from Applications. If macOS asks whether to open an app downloaded from the internet, choose **Open**, then complete Setup. You will grant microphone and privacy permissions during Setup.

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

Production builds containing the automatic updater check for newer stable releases in the background. When ready, choose **Restart now** or **Later** to apply the update at the next app launch. Right-click the menu bar icon for **Check for updates…** or **Restart to update…**. The app finishes the current dictation before an update restart. Downloads of **0.5.5** and earlier need one manual upgrade to **0.5.6**, the first release containing this feature. See [automatic updates](automatic-updates.md).

If you used the earlier **Codex Dictation** app, qqdict imports its recent history and preferences automatically on first launch. Turn off **Open at login** in the old app and quit it so both apps do not run together. Your existing `~/Dictation/` journal stays in place.

Quit qqdict before replacing the app in Applications. If you are upgrading from an older ad hoc preview, macOS may ask you to grant permissions again for the signed app. Settings and recent history remain in qqdict’s Application Support folder; the monthly journal remains in `~/Dictation/`.

To uninstall, turn off **Open at login** in qqdict Settings, quit the app, and move `qqdict.app` from Applications to the Trash. Your journal is left in place.

## Older unnotarized previews

Releases through 0.5.4 and the initial 0.5.5 preview were unnotarized. Download the current 0.5.6 assets above for the notarized build. If you specifically need an older preview and trust its source, attempt to open it once, then use the per-app **Open Anyway** option in **System Settings → Privacy & Security**. That option appears after a blocked launch; see [Apple’s instructions](https://support.apple.com/102445).
