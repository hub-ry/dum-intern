// Dum bridge mode: the only behavior of the controlled helper build (compiled with DUM_BRIDGE).
//
// Dum's main process launches this executable with `--dum-bridge` and talks to it over the inherited
// stdin/stdout pipes, one JSON object per line. The bridge owns one native push-to-talk shortcut:
// key down asks Dum for authorization (`pressed`), Dum answers with `begin`, key up stops and
// transcribes locally, and the final text goes back to Dum only. There is no tray, indicator,
// clipboard, paste, history store or Accessibility use in this mode. Audio lives in a private
// temporary folder and is deleted on completion, cancel, error and the next launch.

#if DUM_BRIDGE
import AVFoundation
import AppKit
import Combine
import Darwin
import FluidAudio
import Foundation
import KeyboardShortcuts

extension KeyboardShortcuts.Name {
    /// The single push-to-talk shortcut Dum configures. No default: nothing is registered until `configure`.
    static let dumVoice = Self("dumVoice")
}

enum DumBridgeFiles {
    /// Bridge-owned temporary audio. Stock OpenSuperWhisper uses a different folder.
    static let recordings: URL = {
        let id = Bundle.main.bundleIdentifier ?? "com.dumintern.opensuperwhisper"
        return FileManager.default.temporaryDirectory.appendingPathComponent("\(id).bridge-recordings", isDirectory: true)
    }()

    /// Removes audio left behind by an earlier run and recreates the folder for this user only.
    static func reset() {
        let files = FileManager.default
        try? files.removeItem(at: recordings)
        try? files.createDirectory(at: recordings, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    static func discard(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}

/// The private line channel. Construct it before anything else runs: it keeps private copies of the
/// inherited stdout (protocol) and stderr (bounded diagnostics), then points file descriptors 1 and 2 at
/// /dev/null so upstream `print` calls and whisper.cpp logging can never corrupt the protocol or leak
/// transcript, audio or path content.
final class DumBridgeChannel {
    static let maxLine = 16 * 1024
    private static let maxNotes = 200

    private let output: FileHandle
    private let log: FileHandle
    private var notes = 0

    init() {
        signal(SIGPIPE, SIG_IGN)
        let out = dup(STDOUT_FILENO)
        let err = dup(STDERR_FILENO)
        let null = open("/dev/null", O_WRONLY)
        guard out >= 0, err >= 0, null >= 0 else { exit(70) }
        _ = fcntl(out, F_SETFD, FD_CLOEXEC)
        _ = fcntl(err, F_SETFD, FD_CLOEXEC)
        dup2(null, STDOUT_FILENO)
        dup2(null, STDERR_FILENO)
        close(null)
        output = FileHandle(fileDescriptor: out, closeOnDealloc: true)
        log = FileHandle(fileDescriptor: err, closeOnDealloc: true)
    }

    /// Writes one event line. False means Dum is gone.
    func send(_ event: [String: Any]) -> Bool {
        guard JSONSerialization.isValidJSONObject(event),
              var data = try? JSONSerialization.data(withJSONObject: event, options: [.withoutEscapingSlashes])
        else { return false }
        data.append(0x0A)
        do {
            try output.write(contentsOf: data)
            return true
        } catch {
            return false
        }
    }

    /// Fixed diagnostic codes only.
    func note(_ code: StaticString) {
        guard notes < Self.maxNotes else { return }
        notes += 1
        try? log.write(contentsOf: Data("dum-voice-bridge: \(code)\n".utf8))
    }

    /// Reads command lines on a background thread and delivers them on the main queue. `end` runs once,
    /// on EOF, a read error or an oversized line.
    func listen(line: @escaping (Data) -> Void, end: @escaping () -> Void) {
        let reader = Thread {
            var pending = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            reading: while true {
                let count = read(STDIN_FILENO, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { break }
                pending.append(contentsOf: buffer[0..<count])
                while let newline = pending.firstIndex(of: 0x0A) {
                    let next = Data(pending[pending.startIndex..<newline])
                    pending = Data(pending[pending.index(after: newline)...])
                    if next.count > Self.maxLine { break reading }
                    if !next.isEmpty { DispatchQueue.main.async { line(next) } }
                }
                if pending.count > Self.maxLine { break }
            }
            DispatchQueue.main.async { end() }
        }
        reader.start()
    }
}

struct DumBinding: Equatable {
    let zoneId: String?
    let zoneEpoch: String
    let inputToken: String
    let requestId: String

    init?(_ value: Any?) {
        guard let object = value as? [String: Any],
              Set(object.keys) == ["zoneId", "zoneEpoch", "inputToken", "requestId"],
              let epoch = object["zoneEpoch"] as? String, DumBridge.isToken(epoch),
              let token = object["inputToken"] as? String, DumBridge.isToken(token),
              let request = object["requestId"] as? String, DumBridge.isToken(request)
        else { return nil }
        if object["zoneId"] is NSNull {
            zoneId = nil
        } else if let zone = object["zoneId"] as? String, DumBridge.isZoneId(zone) {
            zoneId = zone
        } else {
            return nil
        }
        zoneEpoch = epoch
        inputToken = token
        requestId = request
    }

    var json: [String: Any] {
        [
            "zoneId": zoneId.map { $0 as Any } ?? (NSNull() as Any),
            "zoneEpoch": zoneEpoch,
            "inputToken": inputToken,
            "requestId": requestId,
        ]
    }
}

@MainActor
final class DumBridge {
    /// Checked by Dum against the bundle's `DumBridgeVersion` and its own expected value.
    static let version = "1"
    static let recordingLimit: TimeInterval = 120
    static let startLimit: TimeInterval = 10
    static let maxTranscriptBytes = 32 * 1024

    private enum Phase { case starting, recording, transcribing }

    private struct Flight {
        let id: String
        let binding: DumBinding
        let gesture: String?
        var phase: Phase
    }

    private let channel: DumBridgeChannel
    private var nonce: String?
    private var shortcutStatus = "none"
    private var pressed: String?
    private var flight: Flight?
    private var startTimer: DispatchWorkItem?
    private var ceiling: DispatchWorkItem?
    private var transcription: Task<Void, Never>?
    private var recordingWatch: AnyCancellable?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var engineKey = DumBridge.currentEngineKey
    private lazy var setup = DumBridgeSetupWindow(changed: { [weak self] in self?.setupChanged() })

    init(channel: DumBridgeChannel) {
        self.channel = channel
    }

    // MARK: validation

    static func isToken(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy { byte in
            (0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte) || byte == 0x2D || byte == 0x5F
        }
    }

    static func isZoneId(_ value: String) -> Bool {
        value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
    }

    private static func isOne(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        return number.doubleValue == 1
    }

    // MARK: status

    static var modelReady: Bool {
        let prefs = AppPreferences.shared
        if prefs.selectedEngine == "fluidaudio" {
            let version: AsrModelVersion = prefs.fluidAudioModelVersion == "v2" ? .v2 : .v3
            return AsrModels.modelsExist(at: AsrModels.defaultCacheDirectory(for: version), version: version)
        }
        guard let path = prefs.selectedWhisperModelPath else { return false }
        return FileManager.default.fileExists(atPath: path)
    }

    private static var currentEngineKey: String {
        let prefs = AppPreferences.shared
        return [prefs.selectedEngine, prefs.selectedWhisperModelPath ?? "", prefs.fluidAudioModelVersion].joined(separator: "\u{1F}")
    }

    private var microphoneStatus: String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return MicrophoneService.shared.getActiveMicrophone() == nil ? "no-device" : "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not-determined"
        @unknown default: return "unknown"
        }
    }

    // MARK: lifecycle

    func start() {
        KeyboardShortcuts.setShortcut(nil, for: .dumVoice)
        KeyboardShortcuts.onKeyDown(for: .dumVoice) { [weak self] in
            MainActor.assumeIsolated { self?.keyDown() }
        }
        KeyboardShortcuts.onKeyUp(for: .dumVoice) { [weak self] in
            MainActor.assumeIsolated { self?.keyUp() }
        }
        recordingWatch = AudioRecorder.shared.$isRecording
            .receive(on: DispatchQueue.main)
            .sink { [weak self] recording in
                guard recording else { return }
                MainActor.assumeIsolated { self?.recordingStarted() }
            }
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
            let token = workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.interrupt() }
            }
            observers.append((workspace, token))
        }
        let distributed = DistributedNotificationCenter.default()
        let locked = distributed.addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.interrupt() }
        }
        observers.append((distributed, locked))
        channel.listen(
            line: { [weak self] data in MainActor.assumeIsolated { self?.handle(data) } },
            end: { [weak self] in MainActor.assumeIsolated { self?.shutdown() } }
        )
    }

    private func shutdown() {
        if let current = flight { abandon(current) }
        for (center, token) in observers { center.removeObserver(token) }
        observers.removeAll()
        DumBridgeFiles.reset()
        exit(0)
    }

    // MARK: commands

    private func handle(_ line: Data) {
        guard let command = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
              let op = command["op"] as? String
        else { return reject() }
        let keys = Set(command.keys)
        if op != "hello" && nonce == nil { return reject() }
        switch op {
        case "hello":
            guard keys == ["op", "version", "nonce"], Self.isOne(command["version"]),
                  let value = command["nonce"] as? String, Self.isToken(value), nonce == nil
            else { return reject() }
            nonce = value
            _ = TranscriptionService.shared
            sendReady()
        case "configure":
            guard keys == ["op", "voiceHotkey"], let hotkey = command["voiceHotkey"] as? String else { return reject() }
            configure(hotkey)
        case "begin":
            guard keys == ["op", "gestureId", "recordingId", "binding"],
                  let id = command["recordingId"] as? String, Self.isToken(id),
                  let binding = DumBinding(command["binding"])
            else { return reject() }
            if command["gestureId"] is NSNull {
                begin(id, gesture: nil, binding: binding)
            } else if let gesture = command["gestureId"] as? String, Self.isToken(gesture) {
                begin(id, gesture: gesture, binding: binding)
            } else {
                reject()
            }
        case "stop":
            guard keys == ["op", "recordingId"], let id = command["recordingId"] as? String, Self.isToken(id) else { return reject() }
            guard let current = flight, current.id == id else { return failure(id, "unknown-recording", "That recording is no longer active.") }
            finish(current)
        case "cancel":
            guard keys == ["op", "recordingId"], let id = command["recordingId"] as? String, Self.isToken(id) else { return reject() }
            guard let current = flight, current.id == id else { return failure(id, "unknown-recording", "That recording is no longer active.") }
            abandon(current)
            emit(["op": "cancelled", "recordingId": id])
        case "setup":
            guard keys == ["op"] else { return reject() }
            setup.show()
        case "shutdown":
            guard keys == ["op"] else { return reject() }
            shutdown()
        default:
            reject()
        }
    }

    private func reject() {
        channel.note("rejected a command")
        emit(["op": "error", "code": "bad-command", "message": "The voice helper received a command it does not accept."])
    }

    private func configure(_ hotkey: String) {
        if let shortcut = DumShortcut.parse(hotkey) {
            KeyboardShortcuts.setShortcut(shortcut, for: .dumVoice)
            shortcutStatus = "set"
        } else {
            KeyboardShortcuts.setShortcut(nil, for: .dumVoice)
            shortcutStatus = "invalid"
        }
        sendReady()
    }

    private func setupChanged() {
        ensureEngine()
        sendReady()
    }

    /// Reloads the transcription engine when the chosen model changed, including a download that finished
    /// after the setup window closed.
    private func ensureEngine() {
        let key = Self.currentEngineKey
        guard key != engineKey else { return }
        engineKey = key
        TranscriptionService.shared.reloadEngine()
    }

    // MARK: gestures and recording

    private func keyDown() {
        guard nonce != nil, pressed == nil else { return }
        let gesture = UUID().uuidString.lowercased()
        pressed = gesture
        emit(["op": "pressed", "gestureId": gesture])
    }

    private func keyUp() {
        guard let gesture = pressed else { return }
        pressed = nil
        emit(["op": "released", "gestureId": gesture])
        if let current = flight, current.gesture == gesture { finish(current) }
    }

    private func begin(_ id: String, gesture: String?, binding: DumBinding) {
        if flight != nil { return failure(id, "busy", "A recording is already in progress.") }
        if let gesture, gesture != pressed {
            // The key went up before Dum authorized this press: the gesture is over, so nothing starts.
            return emit(["op": "cancelled", "recordingId": id])
        }
        if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
            return failure(id, "microphone-permission", "Allow microphone access in voice setup.")
        }
        if MicrophoneService.shared.getActiveMicrophone() == nil {
            return failure(id, "no-microphone", "No microphone is connected.")
        }
        if !Self.modelReady {
            return failure(id, "model-missing", "Choose a speech model in voice setup.")
        }
        flight = Flight(id: id, binding: binding, gesture: gesture, phase: .starting)
        AudioRecorder.shared.startRecording()
        // AudioRecorder publishes its state with main-queue hops queued during startRecording(); this runs after them.
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.checkStarted(id) }
        }
        let timer = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.failStart(id) }
        }
        startTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.startLimit, execute: timer)
    }

    private func checkStarted(_ id: String) {
        let recorder = AudioRecorder.shared
        if recorder.isRecording { return recordingStarted() }
        if !recorder.isConnecting { failStart(id) }
    }

    private func recordingStarted() {
        guard var current = flight, current.phase == .starting else { return }
        current.phase = .recording
        flight = current
        startTimer?.cancel()
        startTimer = nil
        let id = current.id
        let timer = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.limitReached(id) }
        }
        ceiling = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.recordingLimit, execute: timer)
        emit(["op": "recording", "recordingId": id, "binding": current.binding.json])
    }

    private func failStart(_ id: String) {
        guard let current = flight, current.id == id, current.phase == .starting else { return }
        abandon(current)
        failure(id, "recording-failed", "The microphone did not start recording.")
    }

    private func limitReached(_ id: String) {
        guard let current = flight, current.id == id, current.phase == .recording else { return }
        abandon(current)
        failure(id, "recording-limit", "Recording stopped after two minutes and was discarded.")
    }

    /// Sleep, lock or a lost session: stop everything and keep nothing.
    private func interrupt() {
        if let current = flight {
            abandon(current)
            emit(["op": "cancelled", "recordingId": current.id])
        }
        if let gesture = pressed {
            pressed = nil
            emit(["op": "released", "gestureId": gesture])
        }
    }

    /// Ends the flight without a result and deletes its audio.
    private func abandon(_ current: Flight) {
        startTimer?.cancel()
        startTimer = nil
        ceiling?.cancel()
        ceiling = nil
        switch current.phase {
        case .starting, .recording:
            AudioRecorder.shared.cancelRecording()
        case .transcribing:
            TranscriptionService.shared.cancelTranscription()
            transcription?.cancel()
            transcription = nil
        }
        flight = nil
    }

    /// Release or Stop: end capture and transcribe locally.
    private func finish(_ current: Flight) {
        switch current.phase {
        case .starting:
            abandon(current)
            emit(["op": "cancelled", "recordingId": current.id])
        case .transcribing:
            return
        case .recording:
            ceiling?.cancel()
            ceiling = nil
            guard let audio = AudioRecorder.shared.stopRecording() else {
                flight = nil
                return failure(current.id, "too-short", "The recording was too short to transcribe.")
            }
            var next = current
            next.phase = .transcribing
            flight = next
            emit(["op": "transcribing", "recordingId": current.id, "binding": current.binding.json])
            transcription = Task { @MainActor [weak self] in
                defer { DumBridgeFiles.discard(audio) }
                self?.ensureEngine()
                let service = TranscriptionService.shared
                var waits = 0
                while service.isLoading && waits < 300 {
                    try? await Task.sleep(nanoseconds: 100_000_000)
                    waits += 1
                }
                let result: String?
                do {
                    result = try await service.transcribeAudio(url: audio, settings: Settings())
                } catch {
                    result = nil
                }
                self?.transcribed(current.id, result)
            }
        }
    }

    private func transcribed(_ id: String, _ result: String?) {
        guard let current = flight, current.id == id, current.phase == .transcribing else { return }
        flight = nil
        transcription = nil
        guard let result else {
            return failure(id, "transcription-failed", "Transcription failed.")
        }
        let text = result.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return failure(id, "no-speech", "No speech was recognized.") }
        if text.utf8.count > Self.maxTranscriptBytes { return failure(id, "transcript-too-long", "The transcript was too long.") }
        emit(["op": "transcript", "recordingId": id, "binding": current.binding.json, "text": text])
    }

    // MARK: events

    private func failure(_ id: String, _ code: String, _ message: String) {
        emit(["op": "error", "recordingId": id, "code": code, "message": message])
    }

    private func sendReady() {
        guard let nonce else { return }
        emit([
            "op": "ready",
            "version": 1,
            "nonce": nonce,
            "bridgeVersion": Self.version,
            "modelReady": Self.modelReady,
            "microphoneStatus": microphoneStatus,
            "shortcutStatus": shortcutStatus,
        ])
    }

    private func emit(_ event: [String: Any]) {
        if !channel.send(event) { shutdown() }
    }
}
#endif
