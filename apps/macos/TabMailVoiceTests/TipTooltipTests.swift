// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI
import Testing
import Vision
@testable import TabMailVoice

/// The tips as drawn: a dark tooltip, in light and dark mode alike, with an arrow up at the pill,
/// saying what a key does.
@MainActor
struct TipTooltipTests {
    private let scale: CGFloat = 2
    private nonisolated static let tips: [(DictationTip, DictationHotkey)] = [(.switchMode, .rightOption), (.doubleTap, .function), (.doubleTap, .rightOption)]

    /// Read off the drawn tip, on device, line by line: its words around the keycap. (The right ⌥
    /// keycap's symbol is not text Vision reads.)
    @Test(arguments: zip(
        [(DictationTip.switchMode, DictationHotkey.rightOption), (.doubleTap, .function)],
        ["press space to switch between dictation and agent mode", "double-tap fn to dictate without holding"]
    ))
    func saysWhatTheKeyDoes(tip: (DictationTip, DictationHotkey), words: String) throws {
        let renderer = ImageRenderer(content: TipTooltip(tip: tip.0, hotkey: tip.1))
        renderer.scale = 2 * scale
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: try #require(renderer.cgImage)).perform([request])
        let read = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        #expect(read.joined(separator: " ").lowercased() == words, "read \(read)")
    }

    /// The keycap's name is light on its dark key, and the words are drawn larger than the single-line
    /// tip's 11 pt (owner, 2026-09-26: "a bit of a larger font"), measured on device by Vision against
    /// the same words drawn at 11 pt.
    @Test(arguments: zip(
        [(DictationTip.switchMode, DictationHotkey.rightOption), (.doubleTap, .function)],
        ["space", "fn"]
    ))
    func drawsALightKeycapAndLargerWords(tip: (DictationTip, DictationHotkey), key: String) throws {
        let image = try #require({
            let renderer = ImageRenderer(content: TipTooltip(tip: tip.0, hotkey: tip.1))
            renderer.scale = 2 * scale
            return renderer.cgImage
        }())
        let bitmap = NSBitmapImageRep(cgImage: image)
        let lines = try recognize(image)
        let keyLine = try #require(lines.first { $0.string.localizedCaseInsensitiveContains(key) }, "read \(lines.map(\.string))")
        let keyRange = try #require(keyLine.string.range(of: key, options: .caseInsensitive))
        let keyBox = try #require(try keyLine.boundingBox(for: keyRange)?.boundingBox)
        let pixels = VNImageRectForNormalizedRect(keyBox, image.width, image.height)
        var brightest: CGFloat = 0
        for x in Int(pixels.minX)..<Int(pixels.maxX) {
            for y in Int(pixels.minY)..<Int(pixels.maxY) {
                // Vision's rects grow up from the bottom; the bitmap's rows go down from the top.
                brightest = max(brightest, bitmap.colorAt(x: x, y: image.height - 1 - y)?.usingColorSpace(.genericGray)?.whiteComponent ?? 0)
            }
        }
        #expect(brightest > 0.6, "the \(key) keycap's name is not light")

        // The middle line has no keycap: all words.
        let words = try #require(lines.first { !$0.string.localizedCaseInsensitiveContains(key) }?.string)
        let height = { (image: CGImage) throws -> CGFloat in
            let line = try #require(try self.recognize(image).first { $0.string == words })
            return try #require(try line.boundingBox(for: line.string.startIndex..<line.string.endIndex)?.boundingBox).height * CGFloat(image.height)
        }
        let reference = ImageRenderer(content: Text(words).font(.system(size: 11)).foregroundStyle(.white).padding().background(.black))
        reference.scale = 2 * scale
        let referenceImage = try #require(reference.cgImage)
        #expect(try height(image) > height(referenceImage), "\"\(words)\" is not larger than at 11 pt")
    }

    private func recognize(_ image: CGImage) throws -> [VNRecognizedText] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first }
    }

    /// The double-tap tip names the key the user holds.
    @Test func theDoubleTapTipNamesTheHotkey() {
        #expect(TipTooltip(tip: .doubleTap, hotkey: .rightOption).keycap == "right ⌥")
        #expect(TipTooltip(tip: .doubleTap, hotkey: .function).keycap == "fn")
        #expect(TipTooltip(tip: .switchMode, hotkey: .function).keycap == "space")
    }

    /// The whole overlay as a listening hold draws it: the dark Space tip under the light pill.
    @Test func showsUnderTheListeningPill() async throws {
        let transport = StubTransport()
        let thunderbird = FakeThunderbird()
        thunderbird.installed = false
        let controller = DictationController(
            permissions: PermissionsModel(readMicrophone: { .authorized }, readAccessibility: { true }),
            settings: { DictationSettings(hasConsented: true, hotkey: .rightOption, backendURL: URL(string: "https://api.example.com")!, readsScreen: true, emailApp: nil) },
            account: AccountModel(client: AuthClient(transport: transport.transport), store: InMemorySessionStore(Fixtures.session())),
            tips: TipBook(defaults: InMemoryDefaults()),
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
        #expect(controller.tip == .switchMode)
        #expect(middle(darkRows) > middle(lightRows), "the tip is not under the pill")
        #expect(transport.requests.isEmpty)
    }

    /// As tall as its arrow and box, the room `OverlayPanelController.opensUpward` leaves for it, in
    /// `tipLineCount` lines, and not much wider than the listening pill (owner, 2026-09-26: "should
    /// not go too much wider than the pill itself").
    @Test(arguments: tips)
    func takesTheRoomLeftForIt(tip: (DictationTip, DictationHotkey)) {
        let tooltip = TipTooltip(tip: tip.0, hotkey: tip.1)
        let size = NSHostingView(rootView: tooltip).fittingSize
        let pill = NSHostingView(rootView: OverlayView.Pill(mode: .listening, level: 0, language: "en")).fittingSize
        #expect(tooltip.lines.count == DictationConfig.tipLineCount)
        #expect(size.height == DictationConfig.tipArrowHeight + DictationConfig.tipHeight)
        #expect(size.width < 2 * pill.width, "\(size.width) wide beside a \(pill.width) pill")
    }

    @Test(arguments: tips, [ColorScheme.light, .dark])
    func isADarkTooltipWithAnArrowUpAtThePill(tip: (DictationTip, DictationHotkey), scheme: ColorScheme) throws {
        let hint = try render(tip, scheme)
        let width = CGFloat(hint.pixelsWide) / scale
        let arrow = DictationConfig.tipArrowHeight
        let boxMiddle = arrow + DictationConfig.tipHeight / 2

        // The box, left of the keycap, and the arrow's tip at the top centre: dark and opaque.
        for (x, y) in [(3, boxMiddle), (width - 3, boxMiddle), (width / 2, arrow - 1)] {
            let (white, alpha) = pixel(hint, x, y)
            #expect(white < 0.3, "not dark at \(x), \(y)")
            #expect(alpha > 0.8, "not opaque at \(x), \(y)")
        }
        // The words: light text on the dark box, in its left and right parts.
        let left = stride(from: 10, to: width * 0.4, by: 0.5).map { pixel(hint, $0, boxMiddle).white }
        #expect((left.max() ?? 0) > 0.6, "no light text on the left")
        let right = stride(from: width * 0.6, to: width - 8, by: 0.5).map { pixel(hint, $0, boxMiddle).white }
        #expect((right.max() ?? 0) > 0.6, "no light text on the right")
        // Beside the arrow, above the box: nothing drawn.
        for x in [width / 4, width * 3 / 4] {
            #expect(pixel(hint, x, 1).alpha < 0.5, "drawn beside the arrow at \(x)")
        }
    }

    private func render(_ tip: (DictationTip, DictationHotkey), _ scheme: ColorScheme) throws -> NSBitmapImageRep {
        let renderer = ImageRenderer(content: TipTooltip(tip: tip.0, hotkey: tip.1).environment(\.colorScheme, scheme))
        renderer.scale = scale
        return NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
    }

    /// Brightness and opacity at a point, in points from the top left.
    private func pixel(_ bitmap: NSBitmapImageRep, _ x: CGFloat, _ y: CGFloat) -> (white: CGFloat, alpha: CGFloat) {
        guard let colour = bitmap.colorAt(x: Int(x * scale), y: Int(y * scale))?.usingColorSpace(.genericGray) else { return (1, 0) }
        return (colour.whiteComponent, colour.alphaComponent)
    }
}
