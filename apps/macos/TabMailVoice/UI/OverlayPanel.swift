// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI

/// The dictation overlay, anchored at the text cursor: a swirl gathers there while the
/// microphone warms up, then forms a waveform pill, with the dictation's language in a small circle
/// left of the waveform. The pill is the surface for dictation status
/// (and, later, agent responses). While it listens, a tip may show in a tooltip under it and fade after a
/// moment (`DictationTip`: Space switches agent mode, a double tap dictates without holding); in agent mode the tools' bubbles sit in a row above it, and the running tool's border circles. The
/// panel never takes focus, so the target field keeps keyboard focus and receives the paste.
@MainActor
final class OverlayPanelController {
    private let panel: NSPanel
    private var anchor: CGRect?
    private var lookupGeneration = 0
    private var lookupPending = false
    /// The hold was revealed before the caret lookup finished: show once it does, so the
    /// overlay never flashes at the mouse pointer and then jumps.
    private var showWhenLocated = false
    /// Hides the panel once the exit animation (pill → swirl → dispersed) has played.
    private var hideTask: Task<Void, Never>?

    init(controller: DictationController) {
        panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: DictationConfig.overlayCanvasSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = NSHostingView(rootView: OverlayView(controller: controller))
    }

    func update(for phase: DictationController.Phase) {
        switch phase {
        case .idle:
            hideTask?.cancel()
            hideTask = Task { [weak self] in
                try? await Task.sleep(for: DictationConfig.overlayDismissDuration)
                guard !Task.isCancelled else { return }
                self?.panel.orderOut(nil)
            }
            anchor = nil
            lookupGeneration += 1
            lookupPending = false
            showWhenLocated = false
        case .arming:
            // A new hold during the previous exit animation: start clean, at the new caret.
            hideTask?.cancel()
            panel.orderOut(nil)
            // Find the caret while the hold is still invisible, so the overlay can appear
            // there the moment it's revealed.
            locateCaret()
        case .listening, .transcribing, .running, .failed:
            guard !panel.isVisible else { return }
            if lookupPending {
                showWhenLocated = true
                return
            }
            show()
        }
    }

    private func show() {
        showWhenLocated = false
        position()
        panel.orderFrontRegardless()
    }

    private func locateCaret() {
        lookupGeneration += 1
        let current = lookupGeneration
        anchor = nil
        lookupPending = true
        showWhenLocated = false
        let app = NSWorkspace.shared.frontmostApplication?.processIdentifier
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let caret = app.flatMap { CaretLocator.anchorRect(inApp: $0) }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.lookupGeneration == current else { return }
                self.anchor = caret
                self.lookupPending = false
                if self.showWhenLocated {
                    self.show()
                } else if self.panel.isVisible {
                    self.position()
                }
            }
        }
    }

    private func position() {
        let mouse = NSEvent.mouseLocation
        // Without a caret (the app doesn't expose one), gather at the mouse pointer.
        let anchor = anchor ?? CGRect(x: mouse.x, y: mouse.y, width: 1, height: 1)
        let point = CGPoint(x: anchor.midX, y: anchor.midY)
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(point) })
            ?? NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main else { return }
        let origin = Self.overlayOrigin(
            anchor: anchor,
            canvas: DictationConfig.overlayCanvasSize,
            pillHeight: DictationConfig.pillHeight,
            visibleFrame: screen.visibleFrame
        )
        panel.setFrame(NSRect(origin: origin, size: DictationConfig.overlayCanvasSize), display: true)
    }

    /// Canvas origin that puts the pill's top edge just below the caret's line (the pill just
    /// above the line when there's no room below), centred horizontally on the caret and kept
    /// inside the screen's visible area with a tip under it. The canvas is larger than the
    /// pill (room for the swirl); the one-line pill sits vertically centred in it and taller pills
    /// grow downward.
    static func overlayOrigin(anchor: CGRect, canvas: CGSize, pillHeight: CGFloat, visibleFrame: CGRect) -> CGPoint {
        let gap = DictationConfig.overlayCaretGap
        let pillTopInset = (canvas.height - pillHeight) / 2
        var pillTop = anchor.minY - gap
        if opensUpward(anchor: anchor, pillHeight: pillHeight, visibleFrame: visibleFrame) { pillTop = anchor.maxY + gap + pillHeight }
        pillTop = min(max(pillTop, visibleFrame.minY + heightUnderPillTop(pillHeight)), visibleFrame.maxY)
        var x = anchor.midX - canvas.width / 2
        x = min(max(x, visibleFrame.minX), visibleFrame.maxX - canvas.width)
        return CGPoint(x: x, y: pillTop + pillTopInset - canvas.height)
    }

    /// Whether the pill goes above the caret's line, there being no room below for the listening pill
    /// and a tip under it.
    static func opensUpward(anchor: CGRect, pillHeight: CGFloat, visibleFrame: CGRect) -> Bool {
        anchor.minY - DictationConfig.overlayCaretGap - heightUnderPillTop(pillHeight) < visibleFrame.minY
    }

    /// The listening pill and a tip under it, from the pill's top edge down.
    private static func heightUnderPillTop(_ pillHeight: CGFloat) -> CGFloat {
        max(pillHeight, DictationConfig.listeningPillHeight) + DictationConfig.tipFootprint
    }

    /// Centres of agent mode's tool bubbles, of `sizes`, above a pill at `pill` (top-left origin, as
    /// SwiftUI lays out): one row, centred over the pill, `agentBubbleGap` clear of it and apart
    /// (owner, 2026-09-26: "appear on top … like a list on top").
    nonisolated static func bubbleCentres(above pill: CGRect, sizes: [CGSize]) -> [CGPoint] {
        let gap = DictationConfig.agentBubbleGap
        let rowWidth = sizes.map(\.width).reduce(0, +) + gap * CGFloat(max(sizes.count - 1, 0))
        var x = pill.midX - rowWidth / 2
        return sizes.map { size in
            defer { x += size.width + gap }
            return CGPoint(x: x + size.width / 2, y: pill.minY - gap - size.height / 2)
        }
    }

    /// Centre of a tip, of `size`: a tooltip centred `tipGap` under a pill at `pill`
    /// (owner, 2026-09-26: "a tooltip that appears below the middle and disappears after a little").
    /// It fades after its display duration, so even an overlay opened above the caret's line
    /// covers that line only briefly.
    nonisolated static func hintCentre(under pill: CGRect, size: CGSize) -> CGPoint {
        CGPoint(x: pill.midX, y: pill.maxY + DictationConfig.tipGap + size.height / 2)
    }
}

/// Internal for tests (`Pill`).
struct OverlayView: View {
    let controller: DictationController
    /// After the pill goes away, the swirl plays in reverse (spirals out and fades), mirroring
    /// how the overlay appeared.
    @State private var dispersing = false

    enum Mode: Equatable {
        case hidden, swirl, listening, transcribing, running(AgentTool), message(String)
    }

    private var mode: Mode {
        switch controller.phase {
        case .idle, .arming: .hidden
        case .listening: controller.isHearing ? .listening : .swirl
        case .transcribing: .transcribing
        case .running(let tool): .running(tool)
        case .failed(let message): .message(message)
        }
    }

    /// The controller's tip, while the pill listens.
    private var tip: DictationTip? { mode == .listening ? controller.tip : nil }

    /// The tool bubbles show while agent mode listens and works; an error message stands alone.
    private var showsTools: Bool {
        guard controller.mode == .agent else { return false }
        switch mode {
        case .listening, .transcribing, .running: return true
        case .hidden, .swirl, .message: return false
        }
    }

    private func bubble(_ tool: AgentTool) -> some View {
        let running: AgentTool? = if case .running(let tool) = mode { tool } else { nil }
        return ToolBubble(
            tool: tool, appURL: tool == .thunderbird ? controller.emailAppURL : nil,
            isRunning: running == tool, isDimmed: running != nil && running != tool
        )
            .transition(.scale(scale: DictationConfig.pillAppearScale).combined(with: .opacity))
    }

    var body: some View {
        ZStack {
            switch mode {
            case .hidden:
                if dispersing {
                    GatheringSwirl(dispersing: true)
                        .transition(.opacity)
                }
            case .swirl:
                GatheringSwirl()
                    .transition(.opacity)
            case .listening, .transcribing, .running, .message:
                PillLayout {
                    Pill(mode: mode, level: controller.level, language: controller.language)
                        .transition(.scale(scale: DictationConfig.pillAppearScale).combined(with: .opacity))
                    if let tip {
                        TipTooltip(tip: tip, hotkey: controller.settings.hotkey)
                            .layoutValue(key: IsTip.self, value: true)
                            .transition(.opacity)
                    }
                    if showsTools {
                        ForEach(controller.tools, id: \.self) { tool in
                            bubble(tool)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.spring(response: DictationConfig.pillSpringResponse, dampingFraction: DictationConfig.pillSpringDamping), value: mode)
        .animation(.spring(response: DictationConfig.pillSpringResponse, dampingFraction: DictationConfig.pillSpringDamping), value: showsTools)
        .animation(.spring(response: DictationConfig.pillSpringResponse, dampingFraction: DictationConfig.pillSpringDamping), value: controller.tools)
        .animation(.spring(response: DictationConfig.pillSpringResponse, dampingFraction: DictationConfig.pillSpringDamping), value: controller.mode)
        .animation(.easeOut(duration: DictationConfig.pillSpringResponse), value: tip)
        .onChange(of: mode) { old, new in
            dispersing = new == .hidden && old != .hidden
        }
    }

    struct Pill: View {
        let mode: Mode
        let level: Float
        /// The language the dictation is transcribed in, shown while listening; nil shows none.
        var language: String?

        private var isThinking: Bool { mode == .transcribing }
        /// A circle while transcribing, and while an agent tool works (its bubble shows the progress).
        private var isCircle: Bool {
            switch mode {
            case .transcribing, .running: true
            default: false
            }
        }

        var body: some View {
            HStack(spacing: DictationConfig.pillContentSpacing) {
                switch mode {
                case .transcribing:
                    // Shrinks back to a circle while the words are worked out.
                    Color.clear.frame(width: DictationConfig.pillHeight, height: DictationConfig.pillHeight)
                case .running:
                    Image(systemName: "sparkles")
                        .font(.system(size: DictationConfig.agentRunningSymbolSize, weight: .medium))
                        .foregroundStyle(Brand.gradient)
                        .frame(width: DictationConfig.pillHeight, height: DictationConfig.pillHeight)
                case .message(let text):
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(Brand.gradient)
                    Text(text)
                        .font(.system(size: DictationConfig.overlayFontSize, weight: .medium))
                        // The pill is light in light and dark mode alike.
                        .foregroundStyle(Color.black)
                        .lineLimit(DictationConfig.pillMaxTextLines)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: DictationConfig.pillMaxTextWidth, alignment: .leading)
                default:
                    if let language {
                        LanguageBadge(code: language)
                    }
                    Waveform(level: level)
                }
            }
            .padding(.leading, leadingPadding)
            .padding(.trailing, isCircle ? 0 : DictationConfig.pillHorizontalPadding)
            .padding(.vertical, isCircle ? 0 : DictationConfig.pillVerticalPadding)
            .frame(minHeight: DictationConfig.pillHeight)
            // A capsule while one line tall; grows into a rounded rectangle for longer messages,
            // and is a circle (as wide as tall) while thinking.
            .background(Color(white: DictationConfig.pillFillWhite), in: Self.shape)
            .overlay {
                if isThinking {
                    SpinningRim()
                } else {
                    Self.shape.strokeBorder(Brand.gradient, lineWidth: DictationConfig.pillBorderWidth)
                }
            }
            .shadow(color: Brand.purple.opacity(DictationConfig.pillGlowOpacity), radius: DictationConfig.pillGlowRadius)
            .fixedSize()
        }

        /// The language badge sits in the pill's rounded end, centred on its curve.
        private var leadingPadding: CGFloat {
            if isCircle { return 0 }
            if case .message = mode { return DictationConfig.pillHorizontalPadding }
            return language == nil ? DictationConfig.pillHorizontalPadding : DictationConfig.languageBadgeInset
        }

        private static let shape = RoundedRectangle(cornerRadius: DictationConfig.pillHeight / 2, style: .continuous)
    }
}

/// The dictation's language in a small circle at the pill's left end, as its ISO code (`KO`), like the
/// input menu's own label (owner, 2026-09-26: "a small circle … just left of the wave icon"). Internal
/// for tests.
struct LanguageBadge: View {
    let code: String

    var body: some View {
        Text(code.uppercased())
            .font(.system(size: DictationConfig.languageBadgeFontSize, weight: .semibold))
            .foregroundStyle(Brand.gradient)
            .frame(width: DictationConfig.languageBadgeDiameter, height: DictationConfig.languageBadgeDiameter)
            .overlay {
                Circle().strokeBorder(Brand.gradient, lineWidth: DictationConfig.pillBorderWidth)
            }
            .fixedSize()
            .accessibilityLabel(Locale.current.localizedString(forLanguageCode: code) ?? code)
    }
}

/// Marks the tip among `PillLayout`'s subviews.
private struct IsTip: LayoutValueKey {
    static let defaultValue = false
}

/// Places the pill with its top edge where a one-line pill's would be when centred in the canvas, so
/// taller pills grow downward, away from the caret line; agent mode's tool bubbles go in a row above
/// it, and a tip under it (`OverlayPanelController.bubbleCentres`, `hintCentre`), following
/// it as it grows or shrinks to a circle.
private struct PillLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let pill = subviews.first else { return }
        let size = pill.sizeThatFits(.unspecified)
        let frame = CGRect(
            x: bounds.midX - size.width / 2, y: bounds.minY + (bounds.height - DictationConfig.pillHeight) / 2,
            width: size.width, height: size.height
        )
        pill.place(at: frame.origin, anchor: .topLeading, proposal: .unspecified)
        let others = subviews.dropFirst()
        let bubbles = others.filter { !$0[IsTip.self] }
        let sizes = bubbles.map { $0.sizeThatFits(.unspecified) }
        let centres = OverlayPanelController.bubbleCentres(above: frame, sizes: sizes)
        for (bubble, centre) in zip(bubbles, centres) {
            bubble.place(at: centre, anchor: .center, proposal: .unspecified)
        }
        for hint in others where hint[IsTip.self] {
            let centre = OverlayPanelController.hintCentre(under: frame, size: hint.sizeThatFits(.unspecified))
            hint.place(at: centre, anchor: .center, proposal: .unspecified)
        }
    }
}

/// A tip in a tooltip under the listening pill (owner, 2026-09-26: small, then "professional … almost
/// a black background"): a dark rounded box with an arrow up at the pill, the tip's words around a
/// keycap. Internal for tests.
struct TipTooltip: View {
    let tip: DictationTip
    /// The key held to dictate, which the double-tap tip names.
    let hotkey: DictationHotkey

    /// The words before the keycap, the key, and the words after it.
    var words: (before: String, key: String, after: String) {
        switch tip {
        case .switchMode: ("Press", "space", "to switch between dictation and agent mode")
        case .doubleTap: ("Double-tap", hotkey.keycap, "to dictate without holding")
        }
    }

    private static let shape = TooltipShape(
        arrowWidth: DictationConfig.tipArrowWidth,
        arrowHeight: DictationConfig.tipArrowHeight,
        cornerRadius: DictationConfig.tipCornerRadius
    )

    var body: some View {
        HStack(spacing: DictationConfig.tipSpacing) {
            Text(words.before)
                .font(.system(size: DictationConfig.tipFontSize, weight: .medium))
                .foregroundStyle(Color.white.opacity(DictationConfig.tipTextOpacity))
            Text(words.key)
                .font(.system(size: DictationConfig.tipKeyFontSize, weight: .medium))
                .foregroundStyle(Color.white.opacity(DictationConfig.tipKeyTextOpacity))
                .padding(.horizontal, DictationConfig.tipKeyPadding)
                .frame(height: DictationConfig.tipKeyHeight)
                .background {
                    RoundedRectangle(cornerRadius: DictationConfig.tipKeyCornerRadius)
                        .fill(Color.white.opacity(DictationConfig.tipKeyFillOpacity))
                    RoundedRectangle(cornerRadius: DictationConfig.tipKeyCornerRadius)
                        .strokeBorder(Color.white.opacity(DictationConfig.tipKeyBorderOpacity), lineWidth: DictationConfig.pillBorderWidth)
                }
            Text(words.after)
                .font(.system(size: DictationConfig.tipFontSize, weight: .medium))
                .foregroundStyle(Color.white.opacity(DictationConfig.tipTextOpacity))
        }
        .padding(.horizontal, DictationConfig.tipHorizontalPadding)
        .frame(height: DictationConfig.tipHeight)
        .padding(.top, DictationConfig.tipArrowHeight)
        // Dark in light and dark mode alike, as macOS HUDs are.
        .background(Color(white: DictationConfig.tipFillWhite).opacity(DictationConfig.tipFillOpacity), in: Self.shape)
        .overlay {
            Self.shape.stroke(Color.white.opacity(DictationConfig.tipBorderOpacity), lineWidth: DictationConfig.pillBorderWidth)
        }
        .shadow(color: .black.opacity(DictationConfig.tipShadowOpacity), radius: DictationConfig.tipShadowRadius, y: DictationConfig.tipShadowOffsetY)
        .fixedSize()
    }

    /// A rounded box under an arrow centred on its top edge, one outline so the fill and the border
    /// run around the arrow without a seam.
    private struct TooltipShape: Shape {
        let arrowWidth: CGFloat
        let arrowHeight: CGFloat
        let cornerRadius: CGFloat

        func path(in rect: CGRect) -> Path {
            let top = rect.minY + arrowHeight
            let radius = min(cornerRadius, (rect.maxY - top) / 2)
            return Path { path in
                path.move(to: CGPoint(x: rect.minX + radius, y: top))
                path.addLine(to: CGPoint(x: rect.midX - arrowWidth / 2, y: top))
                path.addLine(to: CGPoint(x: rect.midX, y: rect.minY))
                path.addLine(to: CGPoint(x: rect.midX + arrowWidth / 2, y: top))
                path.addArc(tangent1End: CGPoint(x: rect.maxX, y: top), tangent2End: CGPoint(x: rect.maxX, y: rect.maxY), radius: radius)
                path.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.maxY), tangent2End: CGPoint(x: rect.minX, y: rect.maxY), radius: radius)
                path.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.maxY), tangent2End: CGPoint(x: rect.minX, y: top), radius: radius)
                path.addArc(tangent1End: CGPoint(x: rect.minX, y: top), tangent2End: CGPoint(x: rect.maxX, y: top), radius: radius)
                path.closeSubpath()
            }
        }
    }
}

/// One of agent mode's tools above the pill: a circle with its icon only (owner, 2026-09-26: with a
/// single writing tool shown, the name adds nothing), with its app's icon when it hands the request to an
/// app. While its tool runs, it springs up larger and a gradient arc circles its border; the other
/// tools fade. Internal for tests.
struct ToolBubble: View {
    let tool: AgentTool
    /// The app the tool hands the request to, if any.
    let appURL: URL?
    let isRunning: Bool
    let isDimmed: Bool

    private var appIcon: NSImage? {
        appURL.map { NSWorkspace.shared.icon(forFile: $0.path) }
    }

    var body: some View {
        Group {
            if let appIcon {
                Image(nsImage: appIcon)
                    .resizable()
                    .frame(width: DictationConfig.agentBubbleAppIconSize, height: DictationConfig.agentBubbleAppIconSize)
            } else {
                Image(systemName: tool.symbolName)
                    .font(.system(size: DictationConfig.agentBubbleSymbolSize, weight: .medium))
                    .foregroundStyle(Brand.gradient)
            }
        }
        .frame(width: DictationConfig.agentBubbleDiameter, height: DictationConfig.agentBubbleDiameter)
        // The bubble is light in light and dark mode alike, as the pill.
        .background(Color(white: DictationConfig.pillFillWhite), in: Capsule())
        .overlay {
            if isRunning {
                CirclingBorder()
            } else {
                Capsule().strokeBorder(Brand.gradient, lineWidth: DictationConfig.pillBorderWidth)
            }
        }
        .shadow(color: Brand.purple.opacity(DictationConfig.pillGlowOpacity), radius: DictationConfig.pillGlowRadius)
        .scaleEffect(isRunning ? DictationConfig.agentBubbleRunningScale : 1, anchor: .bottom)
        .animation(.spring(response: DictationConfig.agentBubbleRunningSpringResponse, dampingFraction: DictationConfig.agentBubbleRunningSpringDamping), value: isRunning)
        .opacity(isDimmed ? DictationConfig.agentBubbleIdleOpacity : 1)
        .fixedSize()
        .accessibilityLabel(tool.displayName)
    }
}

/// A bubble's border while its tool runs: a blue → violet highlight sweeping around a faint track,
/// the capsule counterpart of the thinking circle's `SpinningRim`.
private struct CirclingBorder: View {
    var body: some View {
        TimelineView(.animation) { timeline in
            let turns = timeline.date.timeIntervalSinceReferenceDate * DictationConfig.agentBubbleRevolutionsPerSecond
            ZStack {
                Capsule()
                    .strokeBorder(Brand.blue.opacity(DictationConfig.thinkingTrackOpacity), lineWidth: DictationConfig.agentBubbleRimWidth)
                Capsule()
                    .strokeBorder(
                        AngularGradient(
                            colors: [Brand.blue.opacity(0), Brand.blue, Brand.colour(at: DictationConfig.thinkingArcEndColour), Brand.blue.opacity(0)],
                            center: .center,
                            angle: .degrees(360 * turns.truncatingRemainder(dividingBy: 1))
                        ),
                        lineWidth: DictationConfig.agentBubbleRimWidth
                    )
            }
        }
    }
}

/// The overlay uses only the TabMail icon's colours: blue → purple.
private enum Brand {
    private static let blueRGB: (Double, Double, Double) = (0, 0x91 / 255, 1)
    private static let purpleRGB: (Double, Double, Double) = (0x7B / 255, 0, 1)
    static let blue = colour(at: 0)
    static let purple = colour(at: 1)
    static let gradient = LinearGradient(colors: [blue, purple], startPoint: .leading, endPoint: .trailing)

    /// A point on the blue → purple gradient (0 = blue, 1 = purple).
    static func colour(at fraction: Double) -> Color {
        Color(
            red: blueRGB.0 + (purpleRGB.0 - blueRGB.0) * fraction,
            green: blueRGB.1 + (purpleRGB.1 - blueRGB.1) * fraction,
            blue: blueRGB.2 + (purpleRGB.2 - blueRGB.2) * fraction
        )
    }
}

/// Particles spiral inward to the anchor while the microphone warms up, then keep a tight orbit.
/// Dispersing plays it in reverse: out from the orbit, fading away.
private struct GatheringSwirl: View {
    var dispersing = false
    @State private var start = Date()

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, size in
                let elapsed = timeline.date.timeIntervalSince(start)
                let progress = min(1, elapsed / DictationConfig.swirlGatherSeconds)
                let gathered = 1 - pow(1 - progress, 3)
                let eased = dispersing ? 1 - pow(progress, 3) : gathered
                let fade = dispersing ? 1 - progress : 1
                let radius = DictationConfig.swirlStartRadius
                    + (DictationConfig.swirlOrbitRadius - DictationConfig.swirlStartRadius) * eased
                let centre = CGPoint(x: size.width / 2, y: size.height / 2)
                let count = DictationConfig.swirlParticleCount
                for index in 0..<count {
                    let fraction = Double(index) / Double(count)
                    let angle = 2 * .pi * (fraction + elapsed * DictationConfig.swirlRevolutionsPerSecond)
                    // Each particle trails slightly further out, so the ring reads as a spiral.
                    let r = radius * (1 + fraction * DictationConfig.swirlSpiralSpread)
                    let point = CGPoint(x: centre.x + cos(angle) * r, y: centre.y + sin(angle) * r)
                    let dot = DictationConfig.swirlParticleSize * (0.5 + 0.5 * (1 - fraction))
                    let colour = Brand.colour(at: fraction)
                    context.opacity = (0.35 + 0.65 * (1 - fraction)) * fade
                    context.fill(
                        Path(ellipseIn: CGRect(x: point.x - dot / 2, y: point.y - dot / 2, width: dot, height: dot)),
                        with: .color(colour)
                    )
                }
            }
        }
        .onAppear { start = Date() }
    }
}

/// Loading indicator on the thinking circle's rim: a blue → violet arc with a fading tail,
/// circling over a faint blue ring.
private struct SpinningRim: View {
    var body: some View {
        TimelineView(.animation) { timeline in
            let turns = timeline.date.timeIntervalSinceReferenceDate * DictationConfig.thinkingRevolutionsPerSecond
            ZStack {
                Circle()
                    .stroke(Brand.blue.opacity(DictationConfig.thinkingTrackOpacity), lineWidth: DictationConfig.thinkingRimWidth)
                Circle()
                    .trim(from: 0, to: DictationConfig.thinkingArcFraction)
                    .stroke(
                        AngularGradient(
                            colors: [Brand.blue.opacity(0), Brand.blue, Brand.colour(at: DictationConfig.thinkingArcEndColour)],
                            center: .center,
                            startAngle: .zero, endAngle: .degrees(360 * DictationConfig.thinkingArcFraction)
                        ),
                        style: StrokeStyle(lineWidth: DictationConfig.thinkingRimWidth, lineCap: .round)
                    )
                    .rotationEffect(.degrees(360 * turns.truncatingRemainder(dividingBy: 1)))
            }
            .padding(DictationConfig.thinkingRimWidth / 2)
        }
    }
}

/// Voice waveform: bars follow the incoming sound level with a travelling ripple.
private struct Waveform: View {
    let level: Float

    var body: some View {
        TimelineView(.animation) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate
            HStack(spacing: DictationConfig.overlayMeterBarSpacing) {
                ForEach(0..<DictationConfig.overlayMeterBarCount, id: \.self) { index in
                    Capsule()
                        .fill(Brand.gradient)
                        .frame(width: DictationConfig.overlayMeterBarWidth, height: barHeight(index, time: time))
                }
            }
            .frame(height: DictationConfig.overlayMeterMaxBarHeight)
        }
    }

    private func barHeight(_ index: Int, time: TimeInterval) -> CGFloat {
        let count = DictationConfig.overlayMeterBarCount
        let centre = Double(count - 1) / 2
        let distance = abs(Double(index) - centre) / max(centre, 1)
        let weight = 1 - distance * (1 - DictationConfig.overlayMeterEdgeBarWeight)
        // Each bar ripples at its own speed, so the motion reads as a voice rather than a meter.
        let speed = DictationConfig.waveformRippleSpeed * (1 + DictationConfig.waveformSpeedVariance * sin(Double(index) * 1.7))
        let ripple = (sin(time * speed - Double(index) * DictationConfig.waveformRipplePhase) + 1) / 2
        // Boost quieter levels so ordinary speech moves the bars visibly, on top of an idle ripple.
        let voice = pow(Double(level), DictationConfig.waveformLevelExponent) * DictationConfig.waveformGain
            * weight * (1 - DictationConfig.waveformRippleDepth + DictationConfig.waveformRippleDepth * ripple)
        let amount = min(1, DictationConfig.waveformIdleLevel * ripple + voice)
        let minHeight = DictationConfig.overlayMeterMinBarHeight
        return minHeight + CGFloat(amount) * (DictationConfig.overlayMeterMaxBarHeight - minHeight)
    }
}
