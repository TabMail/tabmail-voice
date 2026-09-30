// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import Testing
@testable import VoiceMacOSKit

/// An app's icon as the agent's Thunderbird bubble shows it.
struct AppsTests {
    /// The app's own icon, at the size asked: Finder's is blue, where the system's placeholder for an
    /// icon still loading (what Electron's `getFileIcon` handed back for Thunderbird) is a pale gray
    /// square, mean saturation ≈ 0.03.
    @Test @MainActor
    func drawsTheAppsOwnIconAtTheSizeAsked() throws {
        let png = try #require(Apps.iconPNG("/System/Library/CoreServices/Finder.app", pixels: 32))
        let bitmap = try #require(NSBitmapImageRep(data: png))
        #expect(bitmap.pixelsWide == 32 && bitmap.pixelsHigh == 32)

        var saturation = 0.0
        var opaque = 0
        for x in 0..<bitmap.pixelsWide {
            for y in 0..<bitmap.pixelsHigh {
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB), color.alphaComponent > 0.9 else { continue }
                saturation += color.saturationComponent
                opaque += 1
            }
        }
        #expect(opaque > 0)
        #expect(saturation / Double(max(opaque, 1)) > 0.2)
    }
}
