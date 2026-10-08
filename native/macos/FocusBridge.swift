// Dum's focus helper: a small universal (arm64 + x86_64) executable that main runs as a child.
//
// One JSON object per line on stdin/stdout:
//   {"op":"capture","id":…}              → {"op":"captured","id":…,"handle":…}
//   {"op":"restore","id":…,"handle":…}   → {"op":"restored","id":…,"ok":true|false}
//   {"op":"frontmost","id":…}            → {"op":"frontmost","id":…,"app":{bundleId,name,windowId}|null}
//   {"op":"shutdown"}
// It uses NSWorkspace and NSRunningApplication only: no Accessibility, keystrokes, clipboard, AppleScript
// or window contents. A handle names one app captured during this process's lifetime and nothing else.
// Any malformed command ends the process, so main sees the failure instead of a silent fallback.
//
// Build: swiftc -O -target arm64-apple-macos13.0 FocusBridge.swift -o focus-arm64 (and x86_64), then lipo.

import AppKit
import Darwin
import Foundation

let maxLine = 4096
let maxHandles = 64
let maxName = 255

signal(SIGPIPE, SIG_IGN)

func isToken(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy { byte in
        (0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte) || byte == 0x2D || byte == 0x5F
    }
}

func isBundleId(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 255 && value.utf8.allSatisfy { byte in
        (0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte) || byte == 0x2D || byte == 0x2E
    }
}

func send(_ event: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: event, options: [.withoutEscapingSlashes]) else { exit(70) }
    data.append(0x0A)
    do {
        try FileHandle.standardOutput.write(contentsOf: data)
    } catch {
        exit(0)
    }
}

/// The topmost ordinary window of the app, from the window server list (front to back). Window numbers
/// and owners need no Screen Recording permission; titles and pixels are never read.
func windowNumber(of pid: pid_t) -> Int? {
    guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    for window in windows {
        guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let number = (window[kCGWindowNumber as String] as? NSNumber)?.intValue, number >= 0
        else { continue }
        return number
    }
    return nil
}

/// At most `limit` UTF-16 units, cut on a character boundary (main validates names by UTF-16 length).
func clip(_ value: String, _ limit: Int) -> String {
    var units = 0
    var out = ""
    for character in value {
        units += character.utf16.count
        if units > limit { break }
        out.append(character)
    }
    return out
}

func appSignal(_ app: NSRunningApplication) -> [String: Any]? {
    guard let bundleId = app.bundleIdentifier, isBundleId(bundleId) else { return nil }
    return [
        "bundleId": bundleId,
        "name": clip(app.localizedName ?? "", maxName),
        "windowId": windowNumber(of: app.processIdentifier).map { $0 as Any } ?? (NSNull() as Any),
    ]
}

/// Captured apps for this lifetime, oldest first, bounded.
var handles: [(handle: String, app: NSRunningApplication?)] = []

func capture(_ id: String) {
    let handle = UUID().uuidString.lowercased()
    handles.append((handle, NSWorkspace.shared.frontmostApplication))
    if handles.count > maxHandles { handles.removeFirst(handles.count - maxHandles) }
    send(["op": "captured", "id": id, "handle": handle])
}

func restore(_ id: String, _ handle: String) {
    guard let entry = handles.first(where: { $0.handle == handle }), let app = entry.app, !app.isTerminated else {
        return send(["op": "restored", "id": id, "ok": false])
    }
    let ok: Bool
    if #available(macOS 14.0, *), let active = NSWorkspace.shared.frontmostApplication {
        // Cooperative activation (macOS 14+): activate on behalf of the app that is active now.
        ok = app.activate(from: active, options: [])
    } else {
        ok = app.activate(options: [])
    }
    send(["op": "restored", "id": id, "ok": ok])
}

func handle(_ line: Data) {
    guard let command = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
          let op = command["op"] as? String
    else { exit(65) }
    let keys = Set(command.keys)
    if op == "shutdown" {
        guard keys == ["op"] else { exit(65) }
        exit(0)
    }
    guard let id = command["id"] as? String, isToken(id) else { exit(65) }
    switch op {
    case "capture" where keys == ["op", "id"]:
        capture(id)
    case "frontmost" where keys == ["op", "id"]:
        let app = NSWorkspace.shared.frontmostApplication.flatMap(appSignal)
        send(["op": "frontmost", "id": id, "app": app.map { $0 as Any } ?? (NSNull() as Any)])
    case "restore" where keys == ["op", "id", "handle"]:
        guard let value = command["handle"] as? String, isToken(value) else { exit(65) }
        restore(id, value)
    default:
        exit(65)
    }
}

let reader = Thread {
    var pending = Data()
    var buffer = [UInt8](repeating: 0, count: 1024)
    while true {
        let count = read(STDIN_FILENO, &buffer, buffer.count)
        if count < 0 && errno == EINTR { continue }
        if count <= 0 { exit(0) }
        pending.append(contentsOf: buffer[0..<count])
        while let newline = pending.firstIndex(of: 0x0A) {
            let line = Data(pending[pending.startIndex..<newline])
            pending = Data(pending[pending.index(after: newline)...])
            if line.count > maxLine { exit(65) }
            if !line.isEmpty { DispatchQueue.main.async { handle(line) } }
        }
        if pending.count > maxLine { exit(65) }
    }
}
reader.start()

// A window-server connection with no Dock icon or menu: NSWorkspace's frontmost-app tracking and
// app activation are only reliable with a running AppKit event loop.
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
application.run()
