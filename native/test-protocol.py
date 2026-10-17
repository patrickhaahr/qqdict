#!/usr/bin/env python3
"""Protocol smoke test. Does not prompt, copy, record, or post any key event."""
import json
from pathlib import Path
import selectors
import subprocess
import sys
import time

bridge = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "build" / "DictationBridge"
process = subprocess.Popen([str(bridge.resolve())], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
selector = selectors.DefaultSelector()
selector.register(process.stdout, selectors.EVENT_READ)
request_id = 0
assertions = 0

def request(command, **arguments):
    global request_id
    request_id += 1
    message = {"id": request_id, "command": command, **arguments}
    process.stdin.write((json.dumps(message) + "\n").encode())
    process.stdin.flush()
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if not selector.select(timeout=0.25):
            continue
        line = process.stdout.readline()
        if not line:
            raise AssertionError("native bridge ended unexpectedly")
        result = json.loads(line)
        if result.get("type") == "response" and result.get("id") == request_id:
            return result
    raise AssertionError("native bridge response timed out")

def check(condition):
    global assertions
    assertions += 1
    assert condition, f"protocol assertion {assertions} failed"

try:
    status = request("status")
    check(status["ok"] and isinstance(status["accessibility"], bool) and isinstance(status["inputMonitoring"], bool))
    check(status["hotkey"] == "fn")
    for hotkey in ["right-option", "ctrl-option", "fn"]:
        result = request("setHotkey", hotkey=hotkey)
        check(result["ok"] and result["hotkey"] == hotkey)
    check(request("setHotkey", hotkey="unsupported")["error"] == "invalid_hotkey")
    clipboard_version = request("clipboardVersion")["changeCount"]
    check(isinstance(clipboard_version, int))
    invalid_stage = request("stageClipboard", text="test words ", targetPid=0, focusId="test-invalid-focus-token")
    check(not invalid_stage["ok"] and invalid_stage["error"] in ["accessibility_required", "focus_required"])
    check(request("clipboardVersion")["changeCount"] == clipboard_version)
    check(request("paste", targetPid=0, focusId="test-invalid-focus-token")["error"] == "invalid_clipboard_version")
    check(request("paste", targetPid=0, focusId="test-invalid-focus-token", changeCount=-1)["error"] == "invalid_clipboard_version")
    # A fabricated focus token must be rejected before any key is posted.
    invalid_paste = request("paste", targetPid=0, focusId="test-invalid-focus-token", changeCount=clipboard_version)
    check(not invalid_paste["ok"] and invalid_paste["error"] in ["accessibility_required", "focus_required"])
    check(request("openSettings", pane="unsupported")["error"] == "invalid_settings_pane")
    check(request("unsupported")["error"] == "unknown_command")
    check(request("stop")["ok"])
    process.wait(timeout=8)
    check(process.returncode == 0)
    print(json.dumps({"type": "protocol-test", "ok": True, "assertions": assertions}))
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=5)
    selector.close()
