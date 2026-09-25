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
            panel.orderOut(nil)
            anchor = nil
            lookupGeneration += 1
        case .arming:
            // Find the caret while the hold is still invisible, so the overlay can appear
            // there the moment it's revealed.
            locateCaret()
        case .listening, .transcribing, .failed:
            guard !panel.isVisible else { return }
            position()
            panel.orderFrontRegardless()
        }
    }

    private func locateCaret() {
        lookupGeneration += 1
        let current = lookupGeneration
        anchor = nil
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let caret = CaretLocator.caretRect()
            DispatchQueue.main.async { [weak self] in
                guard let self, self.lookupGeneration == current else { return }
                self.anchor = caret
                if self.panel.isVisible { self.position() }
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
        let origin = Self.overlayOrigin(anchor: anchor, canvas: DictationConfig.overlayCanvasSize, visibleFrame: screen.visibleFrame)
        panel.setFrame(NSRect(origin: origin, size: DictationConfig.overlayCanvasSize), display: true)
    }

    /// Centres the canvas horizontally on the caret, just below the caret's line (above it when
    /// there's no room below), kept inside the screen's visible area.
    static func overlayOrigin(anchor: CGRect, canvas: CGSize, visibleFrame: CGRect) -> CGPoint {
        let gap = DictationConfig.overlayCaretGap
        var y = anchor.minY - gap - canvas.height
        if y < visibleFrame.minY { y = anchor.maxY + gap }
        y = min(max(y, visibleFrame.minY), visibleFrame.maxY - canvas.height)
        var x = anchor.midX - canvas.width / 2
        x = min(max(x, visibleFrame.minX), visibleFrame.maxX - canvas.width)
        return CGPoint(x: x, y: y)
    }
}

private struct OverlayView: View {
    let controller: DictationController

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
                EmptyView()
            case .swirl:
                GatheringSwirl()
                    .transition(.opacity)
            case .listening, .transcribing, .message:
                Pill(mode: mode, level: controller.level)
                    .transition(.scale(scale: DictationConfig.pillAppearScale).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.spring(response: DictationConfig.pillSpringResponse, dampingFraction: DictationConfig.pillSpringDamping), value: mode)
    }

    private struct Pill: View {
        let mode: Mode
        let level: Float

        var body: some View {
            HStack(spacing: DictationConfig.pillContentSpacing) {
                switch mode {
                case .message(let text):
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(.orange)
                    Text(text)
                        .font(.system(size: DictationConfig.overlayFontSize, weight: .medium))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: DictationConfig.pillMaxTextWidth, alignment: .leading)
                default:
                    Waveform(level: level, isThinking: mode == .transcribing)
                }
            }
            .padding(.horizontal, DictationConfig.pillHorizontalPadding)
            .frame(minHeight: DictationConfig.pillHeight)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Brand.gradient, lineWidth: DictationConfig.pillBorderWidth))
            .shadow(color: Brand.purple.opacity(DictationConfig.pillGlowOpacity), radius: DictationConfig.pillGlowRadius)
            .fixedSize()
        }
    }
}

/// Brand colours from the TabMail icon (blue → purple).
private enum Brand {
    static let blue = Color(red: 0, green: 0x91 / 255, blue: 1)
    static let purple = Color(red: 0x7B / 255, green: 0, blue: 1)
    static let gradient = LinearGradient(colors: [blue, purple], startPoint: .leading, endPoint: .trailing)
}

/// Particles spiral inward to the anchor while the microphone warms up, then keep a tight orbit.
private struct GatheringSwirl: View {
    @State private var start = Date()

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, size in
                let elapsed = timeline.date.timeIntervalSince(start)
                let progress = min(1, elapsed / DictationConfig.swirlGatherSeconds)
                let eased = 1 - pow(1 - progress, 3)
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
                    let colour = fraction < 0.5 ? Brand.blue : Brand.purple
                    context.opacity = 0.35 + 0.65 * (1 - fraction)
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

/// Voice waveform: bars follow the microphone level with a travelling ripple; while
/// transcribing, a gentle sweep shows the app is working.
private struct Waveform: View {
    let level: Float
    let isThinking: Bool

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
        let amount = isThinking
            ? DictationConfig.waveformThinkingLevel * ripple
            : Double(level) * weight * (1 - DictationConfig.waveformRippleDepth + DictationConfig.waveformRippleDepth * ripple)
        let minHeight = DictationConfig.overlayMeterMinBarHeight
        return minHeight + CGFloat(amount) * (DictationConfig.overlayMeterMaxBarHeight - minHeight)
    }
}
