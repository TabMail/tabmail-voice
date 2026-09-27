// swift-tools-version: 6.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import PackageDescription

/// TabMail Voice's macOS helpers: small executables the Electron app starts and talks to over
/// stdin/stdout, one JSON object a line (ADR-DESK-032). `voice-hotkey` owns the keyboard event tap;
/// `voice-macos` does everything else that needs AppKit or Accessibility.
let package = Package(
    name: "VoiceNative",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "voice-hotkey", targets: ["voice-hotkey"]),
        .executable(name: "voice-macos", targets: ["voice-macos"]),
    ],
    targets: [
        .target(name: "VoiceHelperSupport", swiftSettings: strict),
        .target(name: "VoiceHotkeyKit", dependencies: ["VoiceHelperSupport"], swiftSettings: strict),
        .executableTarget(name: "voice-hotkey", dependencies: ["VoiceHotkeyKit", "VoiceHelperSupport"], swiftSettings: strict),
        .target(name: "VoiceMacOSKit", dependencies: ["VoiceHelperSupport"], swiftSettings: strict),
        .executableTarget(name: "voice-macos", dependencies: ["VoiceMacOSKit", "VoiceHelperSupport"], swiftSettings: strict),
        .testTarget(name: "VoiceHotkeyKitTests", dependencies: ["VoiceHotkeyKit"], swiftSettings: strict),
        .testTarget(name: "VoiceMacOSKitTests", dependencies: ["VoiceMacOSKit", "VoiceHelperSupport"], swiftSettings: strict),
        .testTarget(name: "VoiceHelperSupportTests", dependencies: ["VoiceHelperSupport"], swiftSettings: strict),
    ]
)

/// Warnings are errors, as in every TabMail target.
var strict: [SwiftSetting] { [.unsafeFlags(["-warnings-as-errors"])] }
