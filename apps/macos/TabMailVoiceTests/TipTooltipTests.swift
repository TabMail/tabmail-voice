// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI
import Testing
import Vision
@testable import TabMailVoice

/// The tips as drawn: a dark tooltip, in light and dark mode alike, with an arrow at the pill (up, or
/// down at a pill under it), saying what a key does.
@MainActor
struct TipTooltipTests {
    private let scale: CGFloat = 2
    private nonisolated static let tips = DictationTip.allCases.flatMap { tip in DictationHotkey.allCases.map { (tip, $0) } }

    /// Read off the drawn tip, on device, line by line: its words around the keycap. (The right ⌥
    /// keycap's symbol is not text Vision reads.)
    @Test(arguments: zip(
        [(DictationTip.switchMode, DictationHotkey.rightOption), (.doubleTap, .function), (.handsFree, .function)],
        ["press space to switch between dictation and agent mode", "double-tap fn to dictate without holding", "tap fn to finish dictating, or tap esc to cancel"]
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

    /// A configured line's `[key]` is a keycap and `[hotkey]` the dictation key's; the rest is words.
    @Test func configuredLinesBecomeWordsAndKeycaps() {
        #expect(TipTooltip.parts(of: "Tap [hotkey] to finish", hotkey: .function) == [.words("Tap"), .key("fn"), .words("to finish")])
        #expect(TipTooltip.parts(of: "[space] then [hotkey]", hotkey: .rightOption) == [.key("space"), .words("then"), .key("right ⌥")])
        #expect(TipTooltip.parts(of: "dictating, or", hotkey: .function) == [.words("dictating, or")])
        #expect(TipTooltip(tip: .handsFree, hotkey: .function).lines == [
            [.words("Tap"), .key("fn"), .words("to finish")], [.words("dictating, or")], [.words("tap"), .key("esc"), .words("to cancel")],
        ])
    }

    /// The double-tap tip names the key the user holds.
    @Test func theDoubleTapTipNamesTheHotkey() {
        #expect(TipTooltip(tip: .doubleTap, hotkey: .rightOption).keycap == "right ⌥")
        #expect(TipTooltip(tip: .doubleTap, hotkey: .function).keycap == "fn")
        #expect(TipTooltip(tip: .switchMode, hotkey: .function).keycap == "space")
    }

    /// The whole overlay as it listens: the dark tip under the light pill, but for the hands-free tip
    /// in an overlay opened above the caret's line, which is over it (owner, 2026-09-27: "above pill
    /// when opening up"). A hold's Space tip stays under the pill either way.
    @Test(arguments: [(false, false, false), (false, true, false), (true, false, false), (true, true, true)])
    func showsByTheListeningPill(handsFree: Bool, opensUpward: Bool, over: Bool) async throws {
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
        if handsFree {
            controller.handle(.startHandsFree)
            controller.handle(.listenHandsFree)
        } else {
            controller.start()
        }
        defer { controller.cancel() }
        let tip: DictationTip = handsFree ? .handsFree : .switchMode
        let deadline = ContinuousClock.now + .seconds(5)
        while !(controller.phase == .listening && controller.tip == tip), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(controller.phase == .listening && controller.tip == tip)

        let size = DictationConfig.overlayCanvasSize
        let renderer = ImageRenderer(content: OverlayView(controller: controller, opensUpward: opensUpward).frame(width: size.width, height: size.height))
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
        if over {
            #expect(middle(darkRows) < middle(lightRows), "the tip is not over the pill")
        } else {
            #expect(middle(darkRows) > middle(lightRows), "the tip is not under the pill")
        }
        // Its arrow points at the pill: at the pill's centre the tip reaches nearer the pill than a
        // little to the side.
        let pillTop = Int((size.height - DictationConfig.pillHeight) / 2 * scale)
        let pillBottom = pillTop + Int(DictationConfig.listeningPillHeight * scale)
        let dark = { (x: Int) in
            (0..<overlay.pixelsHigh).filter { y in
                let (white, alpha) = self.pixel(overlay, CGFloat(x) / self.scale, CGFloat(y) / self.scale)
                return alpha > 0.8 && white < 0.3 && (over ? y < pillTop : y > pillBottom)
            }
        }
        let centre = overlay.pixelsWide / 2
        let side = centre + Int(DictationConfig.tipArrowWidth * 2 * scale)
        if over {
            #expect(try #require(dark(centre).max()) > (try #require(dark(side).max())), "the arrow does not point down at the pill")
        } else {
            #expect(try #require(dark(centre).min()) < (try #require(dark(side).min())), "the arrow does not point up at the pill")
        }
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

    /// Drawn with its arrow up (`pointsDown` false) or down: `y` is measured from the arrow's side.
    @Test(arguments: tips.flatMap { tip in [false, true].map { (tip.0, tip.1, $0) } }, [ColorScheme.light, .dark])
    func isADarkTooltipWithAnArrowAtThePill(tip: (DictationTip, DictationHotkey, Bool), scheme: ColorScheme) throws {
        let pointsDown = tip.2
        let hint = try render((tip.0, tip.1), scheme, pointsDown: pointsDown)
        let width = CGFloat(hint.pixelsWide) / scale
        let height = CGFloat(hint.pixelsHigh) / scale
        #expect(height == DictationConfig.tipArrowHeight + DictationConfig.tipHeight)
        let pixel = { (x: CGFloat, y: CGFloat) in self.pixel(hint, x, pointsDown ? height - y : y) }
        let arrow = DictationConfig.tipArrowHeight
        let boxMiddle = arrow + DictationConfig.tipHeight / 2

        // The box, left of the keycap, and the arrow's tip at the centre of its side: dark and opaque.
        for (x, y) in [(3, boxMiddle), (width - 3, boxMiddle), (width / 2, arrow - 1)] {
            let (white, alpha) = pixel(x, y)
            #expect(white < 0.3, "not dark at \(x), \(y)")
            #expect(alpha > 0.8, "not opaque at \(x), \(y)")
        }
        // The words: light text on the dark box, in its left and right parts.
        let left = stride(from: 10, to: width * 0.4, by: 0.5).map { pixel($0, boxMiddle).white }
        #expect((left.max() ?? 0) > 0.6, "no light text on the left")
        let right = stride(from: width * 0.6, to: width - 8, by: 0.5).map { pixel($0, boxMiddle).white }
        #expect((right.max() ?? 0) > 0.6, "no light text on the right")
        // Beside the arrow, past the box's edge: nothing drawn.
        for x in [width / 4, width * 3 / 4] {
            #expect(pixel(x, 1).alpha < 0.5, "drawn beside the arrow at \(x)")
        }
    }

    private func render(_ tip: (DictationTip, DictationHotkey), _ scheme: ColorScheme, pointsDown: Bool = false) throws -> NSBitmapImageRep {
        let renderer = ImageRenderer(content: TipTooltip(tip: tip.0, hotkey: tip.1, pointsDown: pointsDown).environment(\.colorScheme, scheme))
        renderer.scale = scale
        return NSBitmapImageRep(cgImage: try #require(renderer.cgImage))
    }

    /// Brightness and opacity at a point, in points from the top left.
    private func pixel(_ bitmap: NSBitmapImageRep, _ x: CGFloat, _ y: CGFloat) -> (white: CGFloat, alpha: CGFloat) {
        guard let colour = bitmap.colorAt(x: Int(x * scale), y: Int(y * scale))?.usingColorSpace(.genericGray) else { return (1, 0) }
        return (colour.whiteComponent, colour.alphaComponent)
    }
}
