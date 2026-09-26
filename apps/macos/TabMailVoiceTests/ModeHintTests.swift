// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI
import Testing
import Vision
@testable import TabMailVoice

/// The Space hint as drawn: a dark tooltip, in light and dark mode alike, with an arrow up at the
/// pill, saying what Space switches to.
@MainActor
struct ModeHintTests {
    private let scale: CGFloat = 2

    /// Read off the drawn hint, on device: the keycap, then what Space switches to.
    @Test(arguments: zip([DictationMode.dictation, .agent], ["agent mode", "exit agent"]))
    func saysWhatSpaceSwitchesTo(mode: DictationMode, action: String) throws {
        let renderer = ImageRenderer(content: ModeHint(mode: mode))
        renderer.scale = 2 * scale
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: try #require(renderer.cgImage)).perform([request])
        #expect((request.results ?? []).compactMap { $0.topCandidates(1).first?.string } == ["space", action])
    }

    /// The whole overlay as a listening hold draws it: the dark hint under the light pill.
    @Test func showsUnderTheListeningPill() async throws {
        let transport = StubTransport()
        let thunderbird = FakeThunderbird()
        thunderbird.installed = false
        let controller = DictationController(
            permissions: PermissionsModel(readMicrophone: { .authorized }, readAccessibility: { true }),
            settings: { DictationSettings(hasConsented: true, backendURL: URL(string: "https://api.example.com")!, readsScreen: true, emailApp: nil) },
            account: AccountModel(client: AuthClient(transport: transport.transport), store: InMemorySessionStore(Fixtures.session())),
            inserter: TextInserter(pasteboard: NSPasteboard(name: NSPasteboard.Name("ai.tabmail.voice.tests.\(UUID().uuidString)")), restoreDelay: .zero, pasteKeystroke: {}),
            thunderbird: thunderbird.relay(),
            capture: ToneCapture(),
            makeTranscriptionClient: { TranscriptionClient(baseURL: $0, transport: transport.transport) },
            makeCompletionsClient: { CompletionsClient(baseURL: $0, transport: transport.transport) }
        )
        controller.start()
        defer { controller.cancel() }
        let deadline = ContinuousClock.now + .seconds(5)
        while !(controller.phase == .listening && controller.isHearing), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(controller.phase == .listening && controller.isHearing)

        let size = DictationConfig.overlayCanvasSize
        let renderer = ImageRenderer(content: OverlayView(controller: controller).frame(width: size.width, height: size.height))
        renderer.scale = scale
        let overlay = NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
        var darkRows: [Int] = []
        var lightRows: [Int] = []
        for y in 0..<overlay.pixelsHigh {
            for x in 0..<overlay.pixelsWide {
                let (white, alpha) = pixel(overlay, CGFloat(x) / scale, CGFloat(y) / scale)
                guard alpha > 0.8 else { continue }
                if white < 0.3 { darkRows.append(y) } else if white > 0.8 { lightRows.append(y) }
            }
        }
        try #require(!darkRows.isEmpty && !lightRows.isEmpty)
        let middle = { (rows: [Int]) in Double(rows.reduce(0, +)) / Double(rows.count) }
        #expect(middle(darkRows) > middle(lightRows), "the hint is not under the pill")
        #expect(transport.requests.isEmpty)
    }

    /// As tall as its arrow and box, the room `OverlayPanelController.opensUpward` leaves for it.
    @Test(arguments: [DictationMode.dictation, .agent])
    func takesTheRoomLeftForIt(mode: DictationMode) {
        let size = NSHostingView(rootView: ModeHint(mode: mode)).fittingSize
        #expect(size.height == DictationConfig.modeHintArrowHeight + DictationConfig.modeHintHeight)
        #expect(size.width > size.height)
    }

    @Test(arguments: [DictationMode.dictation, .agent], [ColorScheme.light, .dark])
    func isADarkTooltipWithAnArrowUpAtThePill(mode: DictationMode, scheme: ColorScheme) throws {
        let hint = try render(mode, scheme)
        let width = CGFloat(hint.pixelsWide) / scale
        let arrow = DictationConfig.modeHintArrowHeight
        let boxMiddle = arrow + DictationConfig.modeHintHeight / 2

        // The box, left of the keycap, and the arrow's tip at the top centre: dark and opaque.
        for (x, y) in [(3, boxMiddle), (width - 3, boxMiddle), (width / 2, arrow - 1)] {
            let (white, alpha) = pixel(hint, x, y)
            #expect(white < 0.3, "not dark at \(x), \(y)")
            #expect(alpha > 0.8, "not opaque at \(x), \(y)")
        }
        // The keycap's "space", and the action right of it: light text on the dark box.
        let key = stride(from: 10, to: width * 0.4, by: 0.5).map { pixel(hint, $0, boxMiddle).white }
        #expect((key.max() ?? 0) > 0.6, "no light text in the keycap")
        let action = stride(from: width * 0.6, to: width - 8, by: 0.5).map { pixel(hint, $0, boxMiddle).white }
        #expect((action.max() ?? 0) > 0.6, "no light text in the action")
        // Beside the arrow, above the box: nothing drawn.
        for x in [width / 4, width * 3 / 4] {
            #expect(pixel(hint, x, 1).alpha < 0.5, "drawn beside the arrow at \(x)")
        }
    }

    private func render(_ mode: DictationMode, _ scheme: ColorScheme) throws -> NSBitmapImageRep {
        let renderer = ImageRenderer(content: ModeHint(mode: mode).environment(\.colorScheme, scheme))
        renderer.scale = scale
        return NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
    }

    /// Brightness and opacity at a point, in points from the top left.
    private func pixel(_ bitmap: NSBitmapImageRep, _ x: CGFloat, _ y: CGFloat) -> (white: CGFloat, alpha: CGFloat) {
        guard let colour = bitmap.colorAt(x: Int(x * scale), y: Int(y * scale))?.usingColorSpace(.genericGray) else { return (1, 0) }
        return (colour.whiteComponent, colour.alphaComponent)
    }
}
