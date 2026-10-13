# qqdict macOS bridge

This small Swift process reads only configured modifier flags. It communicates with
Electron using newline-delimited JSON on stdin/stdout. It reads no field text,
keystroke text, or audio. Clipboard data is retained privately only during an
explicit staging command, and is never serialized or logged.

Build with `zsh native/build.sh`. Test the hotkey state reducer without sending
events using `native/build/DictationBridge --self-test`.
Run `python3 native/test-protocol.py` for status and validation command checks.
The self-test clipboard checks use a temporary named pasteboard; they never read
or alter the user's clipboard. They require access to macOS's pasteboard service,
which a restrictive shell sandbox may deny.

Commands have an arbitrary `id` plus `command`. Every command returns
`{type:"response",id,ok,...}`. Events are
`{type:"hotkey",phase:"down"|"up",hotkey,timestamp}` and
`{type:"permissions",inputMonitoring,accessibility,eventTapActive,hotkey,hotkeyHeld,fnHeld,suppressesFn,pid}`.

| Command | Arguments | Result |
| --- | --- | --- |
| `status` | — | Current permissions and event tap state |
| `captureFocus` | — | `targetPid`, `targetApp`, `targetBundleId`, `secure`, `fieldAvailable`, optional `focusId` and `role` |
| `clipboardVersion` | — | Pasteboard `changeCount`; reads no clipboard data |
| `stageClipboard` | `text` | Privately snapshots clipboard types up to 16 MB, writes transcript, returns `changeCount`, `restoreAvailable` |
| `restoreClipboard` | `changeCount` | Restores the snapshot only if the version still matches, returns `restored` |
| `setHotkey` | `hotkey`: `fn`, `right-option`, or `ctrl-option` | Changes the hold gesture, releasing any current gesture first |
| `paste` | `targetPid`, `focusId` | Checks original app and AX focus, then posts Cmd+V |
| `discardFocus` | `focusId` | Removes an unused captured element |
| `requestInputMonitoring` | — | Calls Apple's permission request; never changes settings |
| `requestAccessibility` | — | Calls Apple's permission request; never changes settings |
| `openSettings` | `pane`: `inputMonitoring`, `accessibility`, `microphone`, or `keyboard` | Opens the indicated macOS Settings pane |
| `stop` | — | Ends the helper cleanly |

Electron may call `stageClipboard` before `paste` and `restoreClipboard` after a
short delay. The version check preserves any new copy the user made, even if the
copied text was identical. Clipboard snapshots never leave this process.
`posted:true` means the paste shortcut was posted; macOS does not provide an
acknowledgement that the target application consumed it.

Automatic paste accepts standard text field, text area, and combo box roles, plus
custom editors that expose a settable text selection range. Other controls fall
back to saved history and Copy.

Automatic paste refuses secure fields, changed focus, expired captures (ten
minutes), missing Accessibility access, or a modifier still held. It never
activates another app, writes a whole field value, or sends Enter. Captured AX
elements stay private to the bridge and are consumed once or expire.

With Accessibility granted, the helper consumes Fn modifier events to avoid its
usual system action. If the globe menu or system dictation still appears, set
macOS's **Press 🌐 key to** setting to **Do Nothing**. This app never changes that
setting. Without Accessibility, the hotkey listener is passive.
Input Monitoring or Accessibility changes may require quitting and reopening the
app. Grant permissions to the installed packaged app. Ad hoc signed builds may
need renewed approval after rebuilding; Developer ID signing provides a more
stable identity across releases.
