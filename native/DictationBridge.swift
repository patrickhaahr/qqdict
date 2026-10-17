import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// This process observes modifier changes, never keyboard text. During insertion
// it reads a bounded cursor context for spacing. Context and clipboard snapshots
// stay private to this process and are never serialized or logged.
final class JSONOutput {
    private let lock = NSLock()

    func send(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        data.append(0x0A)
        lock.lock()
        FileHandle.standardOutput.write(data)
        lock.unlock()
    }
}

enum HoldHotkey: String {
    case fn
    case rightOption = "right-option"
    case controlOption = "ctrl-option"
}

struct HoldHotkeyState {
    var hotkey: HoldHotkey = .fn
    private(set) var held = false

    mutating func update(keyCode: Int64, flags: CGEventFlags, rightOptionDown: Bool = false) -> String? {
        let pressed: Bool
        switch hotkey {
        case .fn:
            guard keyCode == 63 else { return nil }
            pressed = flags.contains(.maskSecondaryFn)
        case .rightOption:
            guard keyCode == 61 else { return nil }
            pressed = rightOptionDown
        case .controlOption:
            guard [58, 59, 61, 62].contains(keyCode) else { return nil }
            pressed = flags.contains(.maskControl) && flags.contains(.maskAlternate)
        }
        guard held != pressed else { return nil }
        held = pressed
        return held ? "down" : "up"
    }

    mutating func release() -> String? {
        guard held else { return nil }
        held = false
        return "up"
    }
}

private struct FocusSnapshot {
    let pid: pid_t
    let element: AXUIElement
    let capturedAt: Date
    var insertion: InsertionPlan?
    var insertionClipboardVersion: Int?
}

private func sameRange(_ lhs: CFRange, _ rhs: CFRange) -> Bool {
    lhs.location == rhs.location && lhs.length == rhs.length
}

private struct InsertionPlan {
    let text: String
    let selection: CFRange
    let replacement: CFRange
    // Retain only the small adjacent strings until paste validation completes.
    let before: String?
    let after: String?

    init(text: String, selection: CFRange, before: String?, after: String?, canReplaceSpaces: Bool) {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var start = selection.location
        var end = selection.location + selection.length
        var prefix = ""
        var suffix = " "
        let punctuation = words.first.map { ".,!?;:…)]}»”’".contains($0) } ?? false
        if punctuation && canReplaceSpaces, let before = before {
            start -= before.utf16.reversed().prefix(while: { $0 == 32 }).count
        } else if !punctuation, let previous = before?.last,
                  !previous.isWhitespace, !"([{«“‘".contains(previous) {
            prefix = " "
        }
        if let after = after, let next = after.first {
            if next == " " && canReplaceSpaces {
                end += after.utf16.prefix(while: { $0 == 32 }).count
            } else if next.isWhitespace || ".,!?;:…)]}»”’".contains(next) {
                suffix = ""
            }
        }
        self.text = words.isEmpty ? "" : prefix + words + suffix
        self.selection = selection
        self.replacement = CFRange(location: start, length: end - start)
        self.before = before
        self.after = after
    }
}

final class ClipboardSession {
    private let board: NSPasteboard
    private let maximumBytes: Int
    private let writeText: (String, NSPasteboard) -> Bool
    private var savedItems: [NSPasteboardItem]?
    private var stagedVersion: Int?

    init(board: NSPasteboard = .general, maximumBytes: Int = 16 * 1024 * 1024,
         writeText: @escaping (String, NSPasteboard) -> Bool = { text, board in board.setString(text, forType: .string) }) {
        self.board = board
        self.maximumBytes = maximumBytes
        self.writeText = writeText
    }

    func stage(text: String) -> [String: Any] {
        let versionBefore = board.changeCount
        var items: [NSPasteboardItem] = []
        var bytesLeft = maximumBytes
        var canRestore = true
        outer: for original in board.pasteboardItems ?? [] {
            let copy = NSPasteboardItem()
            for type in original.types {
                guard let data = original.data(forType: type), data.count <= bytesLeft else {
                    canRestore = false
                    break outer
                }
                bytesLeft -= data.count
                guard copy.setData(data, forType: type) else {
                    canRestore = false
                    break outer
                }
            }
            items.append(copy)
        }
        // A user's new Copy during retrieval takes precedence over staging.
        guard board.changeCount == versionBefore else {
            return ["ok": false, "error": "clipboard_changed"]
        }
        // Do not replace clipboard contents unless every advertised representation
        // can be preserved. Large or unavailable promised data must remain intact.
        guard canRestore else {
            return ["ok": false, "error": "clipboard_snapshot_unavailable", "restoreAvailable": false]
        }
        savedItems = items
        let clearedVersion = board.clearContents()
        guard board.changeCount == clearedVersion else {
            savedItems = nil
            stagedVersion = nil
            return ["ok": false, "error": "clipboard_changed"]
        }
        guard writeText(text, board) else {
            // clearContents has already removed the original. Roll it back only
            // while this session still owns that version; a new Copy wins.
            let restored = replaceWithSnapshot(items, expectedVersion: clearedVersion)
            savedItems = nil
            stagedVersion = nil
            return ["ok": false, "error": "clipboard_write_failed", "restored": restored]
        }
        guard board.changeCount == clearedVersion else {
            savedItems = nil
            stagedVersion = nil
            return ["ok": false, "error": "clipboard_changed"]
        }
        stagedVersion = clearedVersion
        return ["ok": true, "changeCount": clearedVersion, "restoreAvailable": canRestore]
    }

    func hasStagedVersion(_ changeCount: Int) -> Bool {
        return stagedVersion == changeCount && board.changeCount == changeCount
    }

    private func replaceWithSnapshot(_ items: [NSPasteboardItem], expectedVersion: Int) -> Bool {
        guard board.changeCount == expectedVersion else { return false }
        let clearedVersion = board.clearContents()
        guard board.changeCount == clearedVersion else { return false }
        return items.isEmpty || board.writeObjects(items)
    }

    func restore(changeCount: Int) -> [String: Any] {
        let snapshot = savedItems
        let expectedVersion = stagedVersion
        savedItems = nil
        stagedVersion = nil
        guard expectedVersion == changeCount, board.changeCount == changeCount else {
            return ["ok": true, "restored": false, "reason": "clipboard_changed"]
        }
        guard let items = snapshot else {
            return ["ok": true, "restored": false, "reason": "snapshot_unavailable"]
        }
        let restored = replaceWithSnapshot(items, expectedVersion: changeCount)
        return ["ok": restored, "restored": restored]
    }
}

private enum BridgeError: String {
    case accessibilityRequired = "accessibility_required"
    case noFocusedApp = "no_focused_app"
    case noFocusedField = "no_focused_field"
    case secureField = "secure_field"
    case focusChanged = "focus_changed"
    case focusExpired = "focus_expired"
    case focusRequired = "focus_required"
    case modifierHeld = "modifier_held"
    case eventCreationFailed = "event_creation_failed"
    case clipboardChanged = "clipboard_changed"
}

final class DictationBridge {
    private let output: JSONOutput
    private let clipboardSession = ClipboardSession()
    private var hotkeyState = HoldHotkeyState()
    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var tapSuppressesFn = false
    private var timer: Timer?
    private var focusSnapshots: [String: FocusSnapshot] = [:]
    private let focusLifetime: TimeInterval = 10 * 60
    private var previousPermissionState: String?

    init(output: JSONOutput) { self.output = output }

    func start() {
        installEventTapIfPermitted()
        emitPermissions(force: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            // A missed flagsChanged event must never leave a recording running.
            if self.hotkeyState.held, !self.physicallyHeld(),
               let phase = self.hotkeyState.release() {
                self.emitHotkey(phase: phase, reason: "release_recovery")
            }
            self.installEventTapIfPermitted()
            self.emitPermissions()
        }
        if let timer = timer {
            RunLoop.main.add(timer, forMode: .common)
        }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.sessionDidResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self = self, let phase = self.hotkeyState.release() else { return }
            self.emitHotkey(phase: phase, reason: "session_inactive")
        }
    }

    // True means suppress this modifier event when using an active tap.
    func receiveEvent(type: CGEventType, event: CGEvent) -> Bool {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let phase = hotkeyState.release() {
                emitHotkey(phase: phase, reason: "event_tap_disabled")
            }
            if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) }
            emitPermissions(force: true)
            return false
        }
        guard type == .flagsChanged else { return false }
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let rightOption = CGEventSource.keyState(.hidSystemState, key: 61)
        if let phase = hotkeyState.update(keyCode: keyCode, flags: event.flags, rightOptionDown: rightOption) {
            emitHotkey(phase: phase)
        }
        return tapSuppressesFn && hotkeyState.hotkey == .fn && keyCode == 63
    }

    private func physicallyHeld() -> Bool {
        // Hardware state remains authoritative even when the active tap consumes
        // the corresponding Fn event before it reaches the session.
        let flags = CGEventSource.flagsState(.hidSystemState)
        switch hotkeyState.hotkey {
        case .fn: return flags.contains(.maskSecondaryFn)
        case .rightOption: return CGEventSource.keyState(.hidSystemState, key: 61)
        case .controlOption: return flags.contains(.maskControl) && flags.contains(.maskAlternate)
        }
    }

    private func emitHotkey(phase: String, reason: String? = nil) {
        var event: [String: Any] = ["type": "hotkey", "phase": phase, "hotkey": hotkeyState.hotkey.rawValue, "timestamp": Date().timeIntervalSince1970]
        if let reason = reason { event["reason"] = reason }
        output.send(event)
    }

    private func installEventTapIfPermitted() {
        guard CGPreflightListenEventAccess() else {
            if let phase = hotkeyState.release() { emitHotkey(phase: phase, reason: "permission_revoked") }
            removeEventTap()
            return
        }
        let canSuppress = AXIsProcessTrusted()
        if tap != nil && tapSuppressesFn != canSuppress {
            removeEventTap()
        }
        guard tap == nil else { return }
        let context = Unmanaged.passUnretained(self).toOpaque()
        let mask = CGEventMask(1) << CGEventType.flagsChanged.rawValue
        guard let newTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: canSuppress ? .defaultTap : .listenOnly,
            eventsOfInterest: mask,
            callback: { _, type, event, context in
                if let context = context {
                    if Unmanaged<DictationBridge>.fromOpaque(context).takeUnretainedValue().receiveEvent(type: type, event: event) {
                        return nil
                    }
                }
                return Unmanaged.passUnretained(event)
            },
            userInfo: context
        ) else { return }
        tap = newTap
        tapSuppressesFn = canSuppress
        tapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, newTap, 0)
        if let tapSource = tapSource {
            CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, .commonModes)
        }
        CGEvent.tapEnable(tap: newTap, enable: true)
    }

    private func permissions() -> [String: Any] {
        return [
            "inputMonitoring": CGPreflightListenEventAccess(),
            "accessibility": AXIsProcessTrusted(),
            "eventTapActive": tap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false,
            "hotkey": hotkeyState.hotkey.rawValue,
            "hotkeyHeld": hotkeyState.held,
            "fnHeld": hotkeyState.hotkey == .fn && hotkeyState.held,
            "suppressesFn": tapSuppressesFn && hotkeyState.hotkey == .fn,
            "pid": ProcessInfo.processInfo.processIdentifier
        ]
    }

    private func emitPermissions(force: Bool = false) {
        let current = permissions()
        let state = "\(current["inputMonitoring"]!)|\(current["accessibility"]!)|\(current["eventTapActive"]!)"
        guard force || previousPermissionState != state else { return }
        previousPermissionState = state
        var event = current
        event["type"] = "permissions"
        output.send(event)
    }

    private func focusedElement(pid: pid_t) -> AXUIElement? {
        let application = AXUIElementCreateApplication(pid)
        // Bound an unresponsive application's accessibility server.
        AXUIElementSetMessagingTimeout(application, 0.3)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &value) == .success,
              let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private func isSecure(_ element: AXUIElement) -> Bool {
        stringAttribute(element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole
    }

    private func acceptsTextInsertion(_ element: AXUIElement) -> Bool {
        if let role = stringAttribute(element, kAXRoleAttribute),
           [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role) { return true }
        // Custom editors may expose text selection without a standard text role.
        // Checking whether a range is settable reads only metadata, not its text.
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(element, kAXSelectedTextRangeAttribute as CFString, &settable) == .success && settable.boolValue
    }

    private func selectedRange(_ element: AXUIElement) -> CFRange? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success,
              let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(value as! AXValue, .cfRange, &range),
              range.location >= 0, range.length >= 0,
              range.location <= Int.max - range.length - 64 else { return nil }
        return range
    }

    private func setSelectedRange(_ element: AXUIElement, _ range: CFRange) -> Bool {
        var range = range
        guard let value = AXValueCreate(.cfRange, &range) else { return false }
        return AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value) == .success
    }

    private func textInRange(_ element: AXUIElement, _ range: CFRange) -> String? {
        if range.length == 0 { return "" }
        var range = range
        guard let value = AXValueCreate(.cfRange, &range) else { return nil }
        var result: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute as CFString, value, &result) == .success,
              let text = result as? String, text.utf16.count == range.length else { return nil }
        return text
    }

    private func cursorContext(_ element: AXUIElement, _ range: CFRange) -> (before: String?, after: String?) {
        // Read at most 64 UTF-16 units on either side, never the field's value.
        let beforeLength = min(range.location, 64)
        let before = textInRange(element, CFRange(location: range.location - beforeLength, length: beforeLength))
        let end = range.location + range.length
        var countValue: CFTypeRef?
        var afterLength = 1
        if AXUIElementCopyAttributeValue(element, kAXNumberOfCharactersAttribute as CFString, &countValue) == .success,
           let count = countValue as? NSNumber, count.intValue >= end {
            afterLength = min(count.intValue - end, 64)
        }
        let after = textInRange(element, CFRange(location: end, length: afterLength))
        return (before, after)
    }

    private func focusError(_ snapshot: FocusSnapshot) -> BridgeError? {
        guard Date().timeIntervalSince(snapshot.capturedAt) < focusLifetime else { return .focusExpired }
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier == snapshot.pid,
              let element = focusedElement(pid: snapshot.pid), CFEqual(element, snapshot.element) else { return .focusChanged }
        if isSecure(element) { return .secureField }
        if !acceptsTextInsertion(element) { return .noFocusedField }
        return nil
    }

    private func captureFocus() -> [String: Any] {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return ["ok": false, "error": BridgeError.noFocusedApp.rawValue]
        }
        var result: [String: Any] = [
            "ok": true,
            "targetPid": app.processIdentifier,
            "targetApp": app.localizedName ?? "Application",
            "targetBundleId": app.bundleIdentifier ?? "",
            "secure": false,
            "fieldAvailable": false
        ]
        guard AXIsProcessTrusted() else {
            result["focusError"] = BridgeError.accessibilityRequired.rawValue
            return result
        }
        guard let element = focusedElement(pid: app.processIdentifier) else {
            result["focusError"] = BridgeError.noFocusedField.rawValue
            return result
        }
        let secure = isSecure(element)
        result["secure"] = secure
        // Do not retain or permit automatic insertion into password fields.
        if secure {
            result["focusError"] = BridgeError.secureField.rawValue
            return result
        }
        guard acceptsTextInsertion(element) else {
            result["focusError"] = BridgeError.noFocusedField.rawValue
            return result
        }
        result["fieldAvailable"] = true
        focusSnapshots = focusSnapshots.filter { Date().timeIntervalSince($0.value.capturedAt) < focusLifetime }
        if focusSnapshots.count > 20 { focusSnapshots.removeAll() }
        let focusID = UUID().uuidString
        focusSnapshots[focusID] = FocusSnapshot(pid: app.processIdentifier, element: element, capturedAt: Date())
        result["focusId"] = focusID
        result["role"] = stringAttribute(element, kAXRoleAttribute) ?? "unknown"
        return result
    }

    private func paste(command: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        guard let clipboardVersion = command["changeCount"] as? Int, clipboardVersion >= 0 else {
            completion(["ok": false, "error": "invalid_clipboard_version"]); return
        }
        guard AXIsProcessTrusted() else {
            completion(["ok": false, "error": BridgeError.accessibilityRequired.rawValue]); return
        }
        guard let focusID = command["focusId"] as? String,
              let snapshot = focusSnapshots.removeValue(forKey: focusID),
              let targetPID = command["targetPid"] as? Int,
              targetPID == Int(snapshot.pid) else {
            completion(["ok": false, "error": BridgeError.focusRequired.rawValue]); return
        }
        guard Date().timeIntervalSince(snapshot.capturedAt) < focusLifetime else {
            completion(["ok": false, "error": BridgeError.focusExpired.rawValue]); return
        }
        var expectedSelection = snapshot.insertion?.selection
        func validate() -> BridgeError? {
            if let error = focusError(snapshot) { return error }
            if snapshot.insertion != nil && snapshot.insertionClipboardVersion != clipboardVersion { return .clipboardChanged }
            if let expected = expectedSelection {
                guard let current = selectedRange(snapshot.element), sameRange(current, expected) else { return .focusChanged }
            }
            if let plan = snapshot.insertion {
                let context = cursorContext(snapshot.element, plan.selection)
                if let before = plan.before, context.before != before { return .focusChanged }
                if let after = plan.after, context.after != after { return .focusChanged }
            }
            let flags = CGEventSource.flagsState(.hidSystemState)
            if flags.intersection([.maskSecondaryFn, .maskCommand, .maskControl, .maskAlternate, .maskShift]).rawValue != 0 {
                return .modifierHeld
            }
            // Keep this last: AX checks can take time. Do not post Cmd+V if a
            // user Copy replaced the transcript, even with identical text.
            if !clipboardSession.hasStagedVersion(clipboardVersion) { return .clipboardChanged }
            return nil
        }
        if let error = validate() {
            completion(["ok": false, "error": error.rawValue]); return
        }
        guard let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else {
            completion(["ok": false, "error": BridgeError.eventCreationFailed.rawValue]); return
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        var adjustedSelection = false
        if let plan = snapshot.insertion, !sameRange(plan.selection, plan.replacement) {
            // Only expand the current selection over adjacent spaces. Cmd+V
            // performs the edit so the target application's undo still works.
            guard setSelectedRange(snapshot.element, plan.replacement) else {
                completion(["ok": false, "error": BridgeError.noFocusedField.rawValue]); return
            }
            expectedSelection = plan.replacement
            adjustedSelection = true
        }
        // Recheck immediately before posting. Never activate another application,
        // replace an entire AX value, or send Return/Enter.
        if let error = validate() {
            if adjustedSelection, let plan = snapshot.insertion, focusError(snapshot) == nil,
               let current = selectedRange(snapshot.element), sameRange(current, plan.replacement) {
                _ = setSelectedRange(snapshot.element, plan.selection)
            }
            completion(["ok": false, "error": error.rawValue]); return
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        // Give the recipient a short opportunity to consume the clipboard.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
            completion(["ok": true, "posted": true, "targetPid": targetPID])
        }
    }

    func handle(_ command: [String: Any]) {
        let id = command["id"] ?? NSNull()
        func respond(_ result: [String: Any]) {
            var result = result
            result["type"] = "response"
            result["id"] = id
            output.send(result)
        }
        switch command["command"] as? String {
        case "status":
            installEventTapIfPermitted()
            var result = permissions()
            result["ok"] = true
            respond(result)
        case "captureFocus":
            respond(captureFocus())
        case "clipboardVersion":
            // Expose only the mutation counter; clipboard data stays in Electron.
            respond(["ok": true, "changeCount": NSPasteboard.general.changeCount])
        case "stageClipboard":
            guard let text = command["text"] as? String, text.utf8.count <= 1_048_576 else {
                respond(["ok": false, "error": "invalid_clipboard_text"]); return
            }
            var insertionText = text
            var prepared: (String, FocusSnapshot)?
            if command["focusId"] != nil || command["targetPid"] != nil {
                guard AXIsProcessTrusted() else {
                    respond(["ok": false, "error": BridgeError.accessibilityRequired.rawValue]); return
                }
                guard let focusID = command["focusId"] as? String,
                      var snapshot = focusSnapshots[focusID],
                      let pid = command["targetPid"] as? Int, pid == Int(snapshot.pid) else {
                    respond(["ok": false, "error": BridgeError.focusRequired.rawValue]); return
                }
                if let error = focusError(snapshot) {
                    respond(["ok": false, "error": error.rawValue]); return
                }
                snapshot.insertion = nil
                if let range = selectedRange(snapshot.element) {
                    let context = cursorContext(snapshot.element, range)
                    var settable: DarwinBoolean = false
                    let canReplace = AXUIElementIsAttributeSettable(snapshot.element, kAXSelectedTextRangeAttribute as CFString, &settable) == .success && settable.boolValue
                    let plan = InsertionPlan(text: text, selection: range, before: context.before, after: context.after, canReplaceSpaces: canReplace)
                    snapshot.insertion = plan
                    insertionText = plan.text
                }
                prepared = (focusID, snapshot)
            }
            let staged = clipboardSession.stage(text: insertionText)
            if staged["ok"] as? Bool == true, let (focusID, originalSnapshot) = prepared {
                var snapshot = originalSnapshot
                snapshot.insertionClipboardVersion = staged["changeCount"] as? Int
                focusSnapshots[focusID] = snapshot
            }
            respond(staged)
        case "restoreClipboard":
            guard let changeCount = command["changeCount"] as? Int else {
                respond(["ok": false, "error": "invalid_clipboard_version"]); return
            }
            respond(clipboardSession.restore(changeCount: changeCount))
        case "setHotkey":
            guard let rawHotkey = command["hotkey"] as? String, let hotkey = HoldHotkey(rawValue: rawHotkey) else {
                respond(["ok": false, "error": "invalid_hotkey"]); return
            }
            if let phase = hotkeyState.release() { emitHotkey(phase: phase, reason: "hotkey_changed") }
            hotkeyState.hotkey = hotkey
            respond(["ok": true, "hotkey": hotkey.rawValue])
            emitPermissions(force: true)
        case "paste":
            paste(command: command, completion: respond)
        case "requestInputMonitoring":
            let granted = CGRequestListenEventAccess()
            installEventTapIfPermitted()
            respond(["ok": true, "granted": granted])
            emitPermissions(force: true)
        case "requestAccessibility":
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            let granted = AXIsProcessTrustedWithOptions(options)
            respond(["ok": true, "granted": granted])
            emitPermissions(force: true)
        case "openSettings":
            let panes = ["inputMonitoring": "Privacy_ListenEvent", "accessibility": "Privacy_Accessibility", "microphone": "Privacy_Microphone", "keyboard": "com.apple.Keyboard-Settings.extension"]
            guard let pane = command["pane"] as? String, let destination = panes[pane] else {
                respond(["ok": false, "error": "invalid_settings_pane"]); return
            }
            let path = pane == "keyboard" ? "x-apple.systempreferences:\(destination)" : "x-apple.systempreferences:com.apple.preference.security?\(destination)"
            let opened = URL(string: path).map { NSWorkspace.shared.open($0) } ?? false
            respond(["ok": opened])
        case "discardFocus":
            if let focusID = command["focusId"] as? String { focusSnapshots.removeValue(forKey: focusID) }
            respond(["ok": true])
        case "stop":
            respond(["ok": true])
            stop()
            NSApplication.shared.terminate(nil)
        default:
            respond(["ok": false, "error": "unknown_command"])
        }
    }

    func stop() {
        timer?.invalidate()
        removeEventTap()
        focusSnapshots.removeAll()
    }

    private func removeEventTap() {
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let tapSource = tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, .commonModes) }
        if let tap = tap { CFMachPortInvalidate(tap) }
        tap = nil
        tapSource = nil
        tapSuppressesFn = false
    }
}

func selfTest(output: JSONOutput) {
    var state = HoldHotkeyState()
    var assertions = 0
    func check(_ condition: Bool, _ label: String) {
        assertions += 1
        if !condition {
            output.send(["type": "self-test", "ok": false, "failure": label])
            exit(1)
        }
    }
    check(state.update(keyCode: 60, flags: []) == nil, "unrelated_modifier_ignored")
    check(state.update(keyCode: 63, flags: .maskSecondaryFn) == "down", "press")
    check(state.update(keyCode: 63, flags: .maskSecondaryFn) == nil, "repeat_ignored")
    check(state.update(keyCode: 56, flags: []) == nil && state.held, "other_modifier_does_not_release")
    check(state.update(keyCode: 63, flags: []) == "up", "release")
    check(state.release() == nil, "duplicate_release_ignored")
    check(state.update(keyCode: 63, flags: .maskSecondaryFn) == "down", "second_press")
    check(state.release() == "up" && !state.held, "recovery_release")
    state.hotkey = .rightOption
    check(state.update(keyCode: 58, flags: .maskAlternate, rightOptionDown: false) == nil, "left_option_ignored")
    check(state.update(keyCode: 61, flags: .maskAlternate, rightOptionDown: true) == "down", "right_option_press")
    check(state.update(keyCode: 61, flags: .maskAlternate, rightOptionDown: false) == "up", "right_option_release_with_left_held")
    state.hotkey = .controlOption
    check(state.update(keyCode: 59, flags: .maskControl) == nil, "control_alone_ignored")
    check(state.update(keyCode: 58, flags: [.maskControl, .maskAlternate]) == "down", "combo_press")
    check(state.update(keyCode: 59, flags: .maskAlternate) == "up", "combo_release")
    func checkInsertion(_ original: String, _ range: NSRange, _ text: String, _ expected: String, _ label: String,
                        canReplaceSpaces: Bool = true, contextAvailable: Bool = true) {
        let source = original as NSString
        let end = range.location + range.length
        let beforeLength = min(range.location, 64)
        let before = contextAvailable ? source.substring(with: NSRange(location: range.location - beforeLength, length: beforeLength)) : nil
        let after = contextAvailable ? source.substring(with: NSRange(location: end, length: min(source.length - end, 64))) : nil
        let plan = InsertionPlan(text: text, selection: CFRange(location: range.location, length: range.length),
                                 before: before, after: after, canReplaceSpaces: canReplaceSpaces)
        let result = source.replacingCharacters(in: NSRange(location: plan.replacement.location, length: plan.replacement.length), with: plan.text)
        check(result == expected, label)
    }
    checkInsertion("", NSRange(location: 0, length: 0), "Hello", "Hello ", "insert_trailing_space")
    checkInsertion("", NSRange(location: 0, length: 0), "  Hello.  \n", "Hello. ", "insert_normalizes_transcript_edges")
    checkInsertion("Hello ", NSRange(location: 6, length: 0), "world.", "Hello world. ", "insert_keeps_existing_separator")
    checkInsertion("Hello", NSRange(location: 5, length: 0), "world", "Hello world ", "insert_adds_missing_separator")
    for mark in [".", ",", "!", "?", ";", ":", "…"] {
        checkInsertion("Hello ", NSRange(location: 6, length: 0), mark, "Hello" + mark + " ", "insert_punctuation_" + mark)
    }
    checkInsertion("Hello   ", NSRange(location: 8, length: 0), ".  ", "Hello. ", "insert_punctuation_removes_multiple_spaces")
    checkInsertion("Hello  world", NSRange(location: 5, length: 0), "there", "Hello there world", "insert_reuses_following_spaces")
    checkInsertion("Hello   world", NSRange(location: 6, length: 0), ".", "Hello. world", "insert_punctuation_between_words")
    checkInsertion("Hello old world", NSRange(location: 6, length: 3), "new", "Hello new world", "insert_replaces_selection")
    checkInsertion("world", NSRange(location: 0, length: 0), "Hello", "Hello world", "insert_at_start")
    checkInsertion("Hello\n", NSRange(location: 6, length: 0), "world", "Hello\nworld ", "insert_preserves_preceding_newline")
    checkInsertion("Hello\nworld", NSRange(location: 5, length: 0), ".", "Hello.\nworld", "insert_preserves_following_newline")
    checkInsertion("Hello,", NSRange(location: 5, length: 0), "world", "Hello world,", "insert_before_existing_punctuation")
    checkInsertion("(", NSRange(location: 1, length: 0), "Hello", "(Hello ", "insert_after_opening_bracket")
    checkInsertion("Hej 👋 ", NSRange(location: 7, length: 0), ".", "Hej 👋. ", "insert_uses_utf16_offsets")
    checkInsertion("Hello ", NSRange(location: 6, length: 0), "world", "Hello world ", "insert_without_context", contextAvailable: false)
    checkInsertion("Hello world", NSRange(location: 5, length: 0), "there", "Hello there world", "insert_without_settable_selection", canReplaceSpaces: false)
    checkInsertion("Hello\tworld", NSRange(location: 5, length: 0), ".", "Hello.\tworld", "insert_preserves_tabs")
    let fallbackPlan = InsertionPlan(text: " \n ", selection: CFRange(location: 0, length: 0), before: nil, after: nil, canReplaceSpaces: false)
    check(fallbackPlan.text.isEmpty, "insert_empty_text_is_empty")
    // Named test pasteboard: these checks never read or mutate the user's clipboard.
    let testBoard = NSPasteboard.withUniqueName()
    defer { testBoard.releaseGlobally() }
    let original = NSPasteboardItem()
    original.setString("private test text", forType: .string)
    let richBytes = Data([0x7B, 0x5C, 0x72, 0x74, 0x66, 0x31, 0x7D])
    original.setData(richBytes, forType: .rtf)
    testBoard.clearContents()
    check(testBoard.writeObjects([original]), "test_clipboard_created")
    let clipboard = ClipboardSession(board: testBoard)
    let staged = clipboard.stage(text: "dictated test")
    check(staged["ok"] as? Bool == true && staged["restoreAvailable"] as? Bool == true, "clipboard_staged")
    check(clipboard.hasStagedVersion(staged["changeCount"] as! Int), "clipboard_staged_version_matches")
    check(!clipboard.hasStagedVersion((staged["changeCount"] as! Int) + 1), "clipboard_wrong_version_rejected")
    check(testBoard.string(forType: .string) == "dictated test", "clipboard_staged_text")
    let restore = clipboard.restore(changeCount: staged["changeCount"] as! Int)
    check(restore["restored"] as? Bool == true && testBoard.data(forType: .rtf) == richBytes, "clipboard_rich_data_restored")
    check(!clipboard.hasStagedVersion(staged["changeCount"] as! Int), "clipboard_restored_session_consumed")
    let secondStage = clipboard.stage(text: "another dictated test")
    // Even copying identical text must inhibit restoration of the previous clipboard.
    testBoard.clearContents()
    testBoard.setString("another dictated test", forType: .string)
    check(!clipboard.hasStagedVersion(secondStage["changeCount"] as! Int), "new_user_copy_blocks_paste")
    let changedRestore = clipboard.restore(changeCount: secondStage["changeCount"] as! Int)
    check(changedRestore["restored"] as? Bool == false && testBoard.string(forType: .string) == "another dictated test", "user_copy_preserved")
    let capped = ClipboardSession(board: testBoard, maximumBytes: 4)
    let versionBeforeCap = testBoard.changeCount
    let cappedStage = capped.stage(text: "dictated")
    check(cappedStage["ok"] as? Bool == false && cappedStage["error"] as? String == "clipboard_snapshot_unavailable", "clipboard_cap_rejected")
    check(testBoard.changeCount == versionBeforeCap && testBoard.string(forType: .string) == "another dictated test", "clipboard_cap_preserves_original")
    final class UnavailableDataProvider: NSObject, NSPasteboardItemDataProvider {
        func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
            // Deliberately leave an advertised representation unavailable.
        }
    }
    let unavailableProvider = UnavailableDataProvider()
    let promisedItem = NSPasteboardItem()
    promisedItem.setString("promised clipboard text", forType: .string)
    check(promisedItem.setDataProvider(unavailableProvider, forTypes: [.rtf]), "clipboard_promise_created")
    testBoard.clearContents()
    check(testBoard.writeObjects([promisedItem]), "clipboard_promise_stored")
    let versionBeforePromise = testBoard.changeCount
    let promisedStage = clipboard.stage(text: "dictated")
    check(promisedStage["ok"] as? Bool == false && promisedStage["error"] as? String == "clipboard_snapshot_unavailable", "clipboard_promise_rejected")
    check(testBoard.changeCount == versionBeforePromise && testBoard.string(forType: .string) == "promised clipboard text", "clipboard_promise_preserves_original")

    func seedRollbackClipboard() {
        let item = NSPasteboardItem()
        item.setString("rollback original", forType: .string)
        item.setData(richBytes, forType: .rtf)
        testBoard.clearContents()
        check(testBoard.writeObjects([item]), "rollback_clipboard_created")
    }
    seedRollbackClipboard()
    let failedWriter = ClipboardSession(board: testBoard, writeText: { _, _ in false })
    let failedStage = failedWriter.stage(text: "dictated")
    check(failedStage["ok"] as? Bool == false && failedStage["error"] as? String == "clipboard_write_failed", "failed_write_reported")
    check(failedStage["restored"] as? Bool == true && testBoard.string(forType: .string) == "rollback original" && testBoard.data(forType: .rtf) == richBytes, "failed_write_restores_rich_original")
    check(!failedWriter.hasStagedVersion(testBoard.changeCount), "failed_write_has_no_staged_session")

    seedRollbackClipboard()
    var copiedDuringFailure = false
    let changedFailedWriter = ClipboardSession(board: testBoard, writeText: { _, board in
        board.clearContents()
        copiedDuringFailure = board.setString("new user copy during failure", forType: .string)
        return false
    })
    let changedFailedStage = changedFailedWriter.stage(text: "dictated")
    check(copiedDuringFailure && changedFailedStage["ok"] as? Bool == false, "failed_write_with_user_copy_reported")
    check(changedFailedStage["restored"] as? Bool == false && testBoard.string(forType: .string) == "new user copy during failure", "failed_write_preserves_new_user_copy")

    seedRollbackClipboard()
    let changedSuccessfulWriter = ClipboardSession(board: testBoard, writeText: { _, board in
        board.clearContents()
        return board.setString("new user copy during staging", forType: .string)
    })
    let changedSuccessfulStage = changedSuccessfulWriter.stage(text: "dictated")
    check(changedSuccessfulStage["ok"] as? Bool == false && changedSuccessfulStage["error"] as? String == "clipboard_changed", "staging_lost_ownership_rejected")
    check(!changedSuccessfulWriter.hasStagedVersion(testBoard.changeCount) && testBoard.string(forType: .string) == "new user copy during staging", "staging_lost_ownership_preserves_user_copy")

    testBoard.clearContents()
    let failedEmptyWriter = ClipboardSession(board: testBoard, writeText: { _, _ in false })
    let failedEmptyStage = failedEmptyWriter.stage(text: "dictated")
    check(failedEmptyStage["restored"] as? Bool == true && testBoard.string(forType: .string) == nil && (testBoard.pasteboardItems ?? []).isEmpty, "failed_write_restores_empty_clipboard")
    output.send(["type": "self-test", "ok": true, "assertions": assertions])
}

let output = JSONOutput()
if CommandLine.arguments.contains("--self-test") {
    selfTest(output: output)
    exit(0)
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let bridge = DictationBridge(output: output)
bridge.start()
DispatchQueue.global(qos: .userInitiated).async {
    var buffer = Data()
    while true {
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty {
            DispatchQueue.main.async { bridge.stop(); NSApplication.shared.terminate(nil) }
            break
        }
        buffer.append(chunk)
        if buffer.count > 65_536 {
            buffer.removeAll()
            output.send(["type": "error", "error": "command_too_large"])
            continue
        }
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: 0..<newline)
            buffer.removeSubrange(0...newline)
            guard !line.isEmpty else { continue }
            guard let object = try? JSONSerialization.jsonObject(with: line), let command = object as? [String: Any] else {
                output.send(["type": "error", "error": "invalid_json_command"])
                continue
            }
            DispatchQueue.main.async { bridge.handle(command) }
        }
    }
}
application.run()
