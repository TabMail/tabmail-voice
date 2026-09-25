// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI

/// The floating pill shown while dictating. It never takes focus, so the target text field
/// keeps keyboard focus and receives the paste.
@MainActor
final class OverlayPanelController {
    private let panel: NSPanel

    init(controller: DictationController) {
        panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: DictationConfig.overlaySize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
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
        if phase == .idle {
            panel.orderOut(nil)
            return
        }
        guard !panel.isVisible else { return }
        position()
        panel.orderFrontRegardless()
    }

    /// Bottom-centre of the screen the user is working on (the one with the mouse).
    private func position() {
        let mouse = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        let size = DictationConfig.overlaySize
        panel.setFrame(
            NSRect(
                x: visible.midX - size.width / 2,
                y: visible.minY + DictationConfig.overlayBottomInset,
                width: size.width,
                height: size.height
            ),
            display: true
        )
    }
}

private struct OverlayView: View {
    let controller: DictationController

    var body: some View {
        HStack(spacing: DictationConfig.overlayContentSpacing) {
            indicator
            Text(caption)
                .font(.system(size: DictationConfig.overlayFontSize, weight: .medium))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, DictationConfig.overlayHorizontalPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial, in: Capsule())
    }

    private var caption: String {
        switch controller.phase {
        case .idle: ""
        case .listening: "Listening…"
        case .transcribing: "Transcribing…"
        case .failed(let message): message
        }
    }

    @ViewBuilder
    private var indicator: some View {
        switch controller.phase {
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        case .transcribing:
            ProgressView().controlSize(.small)
        default:
            LevelMeter(level: controller.level)
        }
    }
}

private struct LevelMeter: View {
    let level: Float

    var body: some View {
        HStack(spacing: DictationConfig.overlayMeterBarSpacing) {
            ForEach(0..<DictationConfig.overlayMeterBarCount, id: \.self) { index in
                Capsule()
                    .fill(Color.accentColor)
                    .frame(width: DictationConfig.overlayMeterBarWidth, height: barHeight(index))
            }
        }
        .frame(height: DictationConfig.overlayMeterMaxBarHeight)
        .animation(.easeOut(duration: DictationConfig.overlayMeterAnimation), value: level)
    }

    /// Centre bars are tallest, so the meter reads as a voice waveform.
    private func barHeight(_ index: Int) -> CGFloat {
        let count = DictationConfig.overlayMeterBarCount
        let centre = Double(count - 1) / 2
        let distance = abs(Double(index) - centre) / max(centre, 1)
        let weight = 1 - distance * (1 - DictationConfig.overlayMeterEdgeBarWeight)
        let minHeight = DictationConfig.overlayMeterMinBarHeight
        return minHeight + CGFloat(Double(level) * weight) * (DictationConfig.overlayMeterMaxBarHeight - minHeight)
    }
}
