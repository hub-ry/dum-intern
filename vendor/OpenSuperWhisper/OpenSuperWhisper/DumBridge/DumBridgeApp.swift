// Entry point of the controlled helper build. It runs only as Dum's voice bridge: launched any other
// way (Finder, Launch Services, a bare exec) it exits without starting anything.

#if DUM_BRIDGE
import AVFoundation
import AppKit
import KeyboardShortcuts
import SwiftUI

@main
struct DumBridgeApp: App {
    @NSApplicationDelegateAdaptor(DumBridgeAppDelegate.self) private var delegate

    init() {
        guard CommandLine.arguments.dropFirst().elementsEqual(["--dum-bridge"]) else { exit(64) }
        // First thing: take the protocol pipes before any upstream code can print.
        DumBridgeAppDelegate.channel = DumBridgeChannel()
    }

    var body: some Scene {
        // OpenSuperWhisper's own `Settings` struct shadows SwiftUI's scene of the same name.
        SwiftUI.Settings { EmptyView() }
    }
}

@MainActor
final class DumBridgeAppDelegate: NSObject, NSApplicationDelegate {
    static var channel: DumBridgeChannel?
    private var bridge: DumBridge?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        guard let channel = Self.channel else { exit(70) }
        DumBridgeFiles.reset()
        let bridge = DumBridge(channel: channel)
        self.bridge = bridge
        bridge.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

/// Microphone permission, language and model choice. Shown only when Dum sends `setup`.
@MainActor
final class DumBridgeSetupWindow: NSObject, NSWindowDelegate {
    private let changed: @MainActor () -> Void
    private var window: NSWindow?

    init(changed: @escaping @MainActor () -> Void) {
        self.changed = changed
    }

    func show() {
        if window == nil {
            let next = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 460, height: 560),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            next.title = "Dum voice setup"
            next.isReleasedWhenClosed = false
            next.contentViewController = NSHostingController(rootView: DumBridgeSetupView(changed: changed))
            next.delegate = self
            next.center()
            window = next
        }
        NSApplication.shared.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        window = nil
        changed()
    }
}

struct DumBridgeSetupView: View {
    let changed: @MainActor () -> Void
    private let language: String
    @StateObject private var models = OnboardingViewModel()
    @State private var microphone = AVCaptureDevice.authorizationStatus(for: .audio)

    init(changed: @escaping @MainActor () -> Void) {
        self.changed = changed
        // OnboardingViewModel resets the language to the system one; keep the user's earlier choice.
        language = AppPreferences.shared.whisperLanguage
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Voice for Dum")
                .font(.title2)
                .fontWeight(.semibold)
            Text("Hold your voice shortcut and talk. Speech is transcribed on this Mac and goes into Dum's draft. Nothing is sent until you press Send.")
                .font(.callout)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            GroupBox("Microphone") {
                HStack {
                    Text(microphoneText)
                    Spacer()
                    if microphone != .authorized {
                        Button("Allow microphone") { requestMicrophone() }
                    }
                }
                .padding(4)
            }
            GroupBox("Language") {
                Picker("Language", selection: $models.selectedLanguage) {
                    ForEach(LanguageUtil.availableLanguages, id: \.self) { code in
                        Text(LanguageUtil.languageNames[code] ?? code).tag(code)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .padding(4)
            }
            GroupBox("Speech model") {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach($models.unifiedModels) { $model in
                            OnboardingUnifiedModelItemView(model: $model, viewModel: models)
                        }
                    }
                    .padding(4)
                }
            }
        }
        .padding(20)
        .frame(width: 460, height: 560)
        .onAppear {
            models.selectedLanguage = language
            if !DumBridge.modelReady, let id = models.selectedModelId,
               let downloaded = models.unifiedModels.first(where: { $0.id == id && $0.isDownloaded }) {
                models.selectModel(downloaded)
            }
            if microphone == .notDetermined { requestMicrophone() }
        }
    }

    private var microphoneText: String {
        switch microphone {
        case .authorized: return "Allowed"
        case .denied: return "Denied. Turn it on in System Settings."
        case .restricted: return "Restricted on this Mac."
        case .notDetermined: return "Not asked yet."
        @unknown default: return "Unknown."
        }
    }

    private func requestMicrophone() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        microphone = AVCaptureDevice.authorizationStatus(for: .audio)
                        changed()
                    }
                }
            }
        default:
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                NSWorkspace.shared.open(url)
            }
        }
    }
}

/// Electron accelerator → native shortcut. Accepts what Dum's settings accept, minus keys a Mac lacks.
enum DumShortcut {
    private static let keys: [String: KeyboardShortcuts.Key] = {
        var keys: [String: KeyboardShortcuts.Key] = [
            "A": .a, "B": .b, "C": .c, "D": .d, "E": .e, "F": .f, "G": .g, "H": .h, "I": .i, "J": .j, "K": .k, "L": .l, "M": .m,
            "N": .n, "O": .o, "P": .p, "Q": .q, "R": .r, "S": .s, "T": .t, "U": .u, "V": .v, "W": .w, "X": .x, "Y": .y, "Z": .z,
            "0": .zero, "1": .one, "2": .two, "3": .three, "4": .four, "5": .five, "6": .six, "7": .seven, "8": .eight, "9": .nine,
            "`": .backtick, "-": .minus, "=": .equal, "[": .leftBracket, "]": .rightBracket, "\\": .backslash, ";": .semicolon,
            "'": .quote, ",": .comma, ".": .period, "/": .slash,
            "Space": .space, "Tab": .tab, "Backspace": .delete, "Delete": .deleteForward, "Return": .`return`, "Enter": .`return`,
            "Up": .upArrow, "Down": .downArrow, "Left": .leftArrow, "Right": .rightArrow, "Home": .home, "End": .end,
            "PageUp": .pageUp, "PageDown": .pageDown, "Escape": .escape, "Esc": .escape,
        ]
        let functions: [KeyboardShortcuts.Key] = [
            .f1, .f2, .f3, .f4, .f5, .f6, .f7, .f8, .f9, .f10, .f11, .f12, .f13, .f14, .f15, .f16, .f17, .f18, .f19, .f20,
        ]
        for (index, key) in functions.enumerated() { keys["F\(index + 1)"] = key }
        return keys
    }()

    static func parse(_ accelerator: String) -> KeyboardShortcuts.Shortcut? {
        var parts = accelerator.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2, let name = parts.popLast(), Set(parts).count == parts.count else { return nil }
        var modifiers: NSEvent.ModifierFlags = []
        for part in parts {
            switch part {
            case "Command", "Cmd", "CommandOrControl", "CmdOrCtrl", "Super", "Meta": modifiers.insert(.command)
            case "Control", "Ctrl": modifiers.insert(.control)
            case "Alt", "Option", "AltGr": modifiers.insert(.option)
            case "Shift": modifiers.insert(.shift)
            default: return nil
            }
        }
        guard !modifiers.subtracting(.shift).isEmpty else { return nil }
        if name == "Plus" { return KeyboardShortcuts.Shortcut(.equal, modifiers: modifiers.union(.shift)) }
        guard let key = keys[name] else { return nil }
        return KeyboardShortcuts.Shortcut(key, modifiers: modifiers)
    }
}
#endif
