// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI

/// The dictation overlay, anchored at the text cursor: a swirl gathers there while the
/// microphone warms up, then forms a waveform pill. The pill is the surface for dictation status
/// (and, later, agent responses). The panel never takes focus, so the target field keeps
/// keyboard focus and receives the paste.
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
        case .listening, .transcribing, .failed:
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
    /// inside the screen's visible area. The canvas is larger than the pill (room for the swirl);
    /// the one-line pill sits vertically centred in it and taller pills grow downward.
    static func overlayOrigin(anchor: CGRect, canvas: CGSize, pillHeight: CGFloat, visibleFrame: CGRect) -> CGPoint {
        let gap = DictationConfig.overlayCaretGap
        let pillTopInset = (canvas.height - pillHeight) / 2
        var pillTop = anchor.minY - gap
        if pillTop - pillHeight < visibleFrame.minY { pillTop = anchor.maxY + gap + pillHeight }
        pillTop = min(max(pillTop, visibleFrame.minY + pillHeight), visibleFrame.maxY)
        var x = anchor.midX - canvas.width / 2
        x = min(max(x, visibleFrame.minX), visibleFrame.maxX - canvas.width)
        return CGPoint(x: x, y: pillTop + pillTopInset - canvas.height)
    }
}

private struct OverlayView: View {
    let controller: DictationController
    /// After the pill goes away, the swirl plays in reverse (spirals out and fades), mirroring
    /// how the overlay appeared.
    @State private var dispersing = false

    private enum Mode: Equatable {
        case hidden, swirl, listening, transcribing, message(String)
    }

    private var mode: Mode {
        switch controller.phase {
        case .idle, .arming: .hidden
        case .listening: controller.isHearing ? .listening : .swirl
        case .transcribing: .transcribing
        case .failed(let message): .message(message)
        }
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
            case .listening, .transcribing, .message:
                Pill(mode: mode, level: controller.level)
                    .transition(.scale(scale: DictationConfig.pillAppearScale).combined(with: .opacity))
                    // Top edge where a one-line pill's would be when centred, so taller pills grow
                    // downward, away from the caret line.
                    .padding(.top, (DictationConfig.overlayCanvasSize.height - DictationConfig.pillHeight) / 2)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.spring(response: DictationConfig.pillSpringResponse, dampingFraction: DictationConfig.pillSpringDamping), value: mode)
        .onChange(of: mode) { old, new in
            dispersing = new == .hidden && old != .hidden
        }
    }

    private struct Pill: View {
        let mode: Mode
        let level: Float

        private var isThinking: Bool { mode == .transcribing }

        var body: some View {
            HStack(spacing: DictationConfig.pillContentSpacing) {
                switch mode {
                case .transcribing:
                    // Shrinks back to a circle while the words are worked out.
                    Color.clear.frame(width: DictationConfig.pillHeight, height: DictationConfig.pillHeight)
                case .message(let text):
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(Brand.gradient)
                    Text(text)
                        .font(.system(size: DictationConfig.overlayFontSize, weight: .medium))
                        .lineLimit(DictationConfig.pillMaxTextLines)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: DictationConfig.pillMaxTextWidth, alignment: .leading)
                default:
                    Waveform(level: level)
                }
            }
            .padding(.horizontal, isThinking ? 0 : DictationConfig.pillHorizontalPadding)
            .padding(.vertical, isThinking ? 0 : DictationConfig.pillVerticalPadding)
            .frame(minHeight: DictationConfig.pillHeight)
            // A capsule while one line tall; grows into a rounded rectangle for longer messages,
            // and is a circle (as wide as tall) while thinking.
            .background(.regularMaterial, in: Self.shape)
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

        private static let shape = RoundedRectangle(cornerRadius: DictationConfig.pillHeight / 2, style: .continuous)
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

/// Loading indicator on the thinking circle's rim: a gradient arc circling over a faint ring.
private struct SpinningRim: View {
    var body: some View {
        TimelineView(.animation) { timeline in
            let turns = timeline.date.timeIntervalSinceReferenceDate * DictationConfig.thinkingRevolutionsPerSecond
            ZStack {
                Circle()
                    .stroke(Brand.purple.opacity(DictationConfig.thinkingTrackOpacity), lineWidth: DictationConfig.thinkingRimWidth)
                Circle()
                    .trim(from: 0, to: DictationConfig.thinkingArcFraction)
                    .stroke(
                        AngularGradient(colors: [Brand.blue, Brand.purple], center: .center,
                                        startAngle: .zero, endAngle: .degrees(360 * DictationConfig.thinkingArcFraction)),
                        style: StrokeStyle(lineWidth: DictationConfig.thinkingRimWidth, lineCap: .round)
                    )
                    .rotationEffect(.degrees(360 * turns.truncatingRemainder(dividingBy: 1)))
            }
            .padding(DictationConfig.thinkingRimWidth / 2)
        }
    }
}

/// Voice waveform: bars follow the microphone level (`LevelMeter`) with a travelling ripple.
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
        let ripple = (sin(time * DictationConfig.waveformRippleSpeed - Double(index) * DictationConfig.waveformRipplePhase) + 1) / 2
        let amount = Double(level) * weight * (1 - DictationConfig.waveformRippleDepth + DictationConfig.waveformRippleDepth * ripple)
        let minHeight = DictationConfig.overlayMeterMinBarHeight
        return minHeight + CGFloat(amount) * (DictationConfig.overlayMeterMaxBarHeight - minHeight)
    }
}
