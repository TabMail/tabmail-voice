// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI
import Testing
import Vision
@testable import TabMailVoice

/// An input source's languages → the language a dictation is sent with.
struct KeyboardLanguageTests {
    @Test(arguments: [
        // Korean 2-Set reports only Korean.
        (["ko"], "ko"),
        // The U.S. layout lists English first, then every language it can type (96 on macOS 26).
        (["en", "af", "asa", "bem", "ca"], "en"),
        // A script or region variant → its primary subtag.
        (["zh-Hans"], "zh"),
        (["pt_BR"], "pt"),
        (["sr-Latn-RS"], "sr"),
        (["EN"], "en"),
    ])
    func takesTheFirstLanguagesPrimarySubtag(languages: [String], expected: String) {
        #expect(KeyboardLanguage.code(forSourceLanguages: languages) == expected)
    }

    /// No two-letter code to send: the backend accepts only ISO-639-1, so the dictation sends none.
    @Test(arguments: [[], ["yue"], ["fil", "en"], [""], ["e1"], ["-"]])
    func sendsNoneWithoutATwoLetterCode(languages: [String]) {
        #expect(KeyboardLanguage.code(forSourceLanguages: languages) == nil)
    }

    /// The live read: whatever the Mac's keyboard is, a two-letter lowercase code or none.
    @MainActor
    @Test func readsTheActiveKeyboard() {
        if let code = KeyboardLanguage.current() {
            #expect(code.count == 2 && code.allSatisfy { ("a"..."z").contains($0) })
        }
    }
}

/// The language badge as drawn: the same language the dictation's request sends, left of the waveform.
@MainActor
struct LanguageBadgeTests {
    private let scale: CGFloat = 4

    /// A listening hold on a Korean keyboard shows "KO" in the overlay, and its recording is sent with
    /// `ko`; on a keyboard without a language the overlay shows no text and the request no language.
    @Test(arguments: [("ko", ["KO"]), (nil, [])] as [(String?, [String])])
    func showsTheLanguageTheRequestSends(keyboard: String?, drawn: [String]) async throws {
        let transport = StubTransport()
        transport.enqueue(status: 200, json: ["text": ""])
        let thunderbird = FakeThunderbird()
        thunderbird.installed = false
        let controller = DictationController(
            permissions: PermissionsModel(readMicrophone: { .authorized }, readAccessibility: { true }),
            settings: { DictationSettings(hasConsented: true, backendURL: URL(string: "https://api.example.com")!, readsScreen: false, emailApp: nil) },
            account: AccountModel(client: AuthClient(transport: transport.transport), store: InMemorySessionStore(Fixtures.session())),
            inserter: TextInserter(pasteboard: NSPasteboard(name: NSPasteboard.Name("ai.tabmail.voice.tests.\(UUID().uuidString)")), restoreDelay: .zero, pasteKeystroke: {}),
            thunderbird: thunderbird.relay(),
            capture: ToneCapture(),
            keyboardLanguage: { keyboard },
            makeTranscriptionClient: { TranscriptionClient(baseURL: $0, transport: transport.transport) },
            makeCompletionsClient: { CompletionsClient(baseURL: $0, transport: transport.transport) }
        )
        controller.start()
        defer { controller.cancel() }
        try #require(await eventually { controller.phase == .listening && controller.isHearing })

        let size = DictationConfig.overlayCanvasSize
        let renderer = ImageRenderer(content: OverlayView(controller: controller).frame(width: size.width, height: size.height))
        renderer.scale = scale
        // Besides the Space hint under the pill.
        let read = try recognisedText(try #require(renderer.cgImage)).filter { !$0.contains("space") && !$0.contains("agent mode") }
        #expect(read == drawn, "read \(read)")

        controller.finish()
        try #require(await eventually { !transport.requests.isEmpty })
        #expect(Fixtures.jsonBody(of: transport.requests[0])["language"] as? String == keyboard)
    }

    /// Left of the waveform, inside the pill, which keeps its listening height.
    @Test func sitsLeftOfTheWaveformWithoutGrowingThePill() throws {
        let plain = NSHostingView(rootView: OverlayView.Pill(mode: .listening, level: 0)).fittingSize
        let badged = NSHostingView(rootView: OverlayView.Pill(mode: .listening, level: 0, language: "ko")).fittingSize
        let diameter = DictationConfig.languageBadgeDiameter
        #expect(badged.height == plain.height)
        #expect(NSHostingView(rootView: LanguageBadge(code: "ko")).fittingSize == CGSize(width: diameter, height: diameter))
        // The badge and its gap to the waveform, in the pill's rounded end in place of its usual padding.
        let inset = DictationConfig.languageBadgeInset
        #expect(badged.width - plain.width == diameter + DictationConfig.pillContentSpacing + inset - DictationConfig.pillHorizontalPadding)
        #expect(inset == (badged.height - diameter) / 2, "not concentric with the rounded end")

        // Drawn, "KO" is within the badge's room at the pill's left end, not beside the waveform's right.
        let renderer = ImageRenderer(content: OverlayView.Pill(mode: .listening, level: 0, language: "ko"))
        renderer.scale = scale
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: try #require(renderer.cgImage)).perform([request])
        let code = try #require(request.results?.first { $0.topCandidates(1).first?.string == "KO" })
        #expect(code.boundingBox.maxX * badged.width <= inset + diameter, "KO drawn at \(code.boundingBox.minX * badged.width)…\(code.boundingBox.maxX * badged.width) of \(badged.width)")
    }

    /// The badge is for the listening pill only: a message or the thinking circle draws the same with
    /// or without a language.
    @Test(arguments: [OverlayView.Mode.transcribing, .message("Didn't catch that. Try again.")])
    func showsOnlyWhileListening(mode: OverlayView.Mode) {
        let plain = NSHostingView(rootView: OverlayView.Pill(mode: mode, level: 0)).fittingSize
        let badged = NSHostingView(rootView: OverlayView.Pill(mode: mode, level: 0, language: "ko")).fittingSize
        #expect(badged == plain)
    }

    private func recognisedText(_ image: CGImage) throws -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    }

    /// Polls `condition` until it holds, for up to five seconds.
    private func eventually(_ condition: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition() {
            guard ContinuousClock.now < deadline else { return false }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return true
    }
}
