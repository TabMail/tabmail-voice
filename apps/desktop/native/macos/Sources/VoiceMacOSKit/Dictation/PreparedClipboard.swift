// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import os
import VoiceHelperSupport

/// The native writer owns a prepared offer's lifetime, including a lost acknowledgement. An
/// operation is known before its request is sent, so finish/cancellation can precede preparation.
@MainActor
final class PreparedClipboard {
    private let clipboard: ClipboardKeeper
    nonisolated private let ended = OSAllocatedUnfairLock<Int>(initialState: 0)
    private var latest = 0
    private var current: (operation: Int, transaction: Int, expiry: Task<Void, Never>)?

    init(_ clipboard: ClipboardKeeper) { self.clipboard = clipboard }

    nonisolated func end(_ operation: Int) { ended.withLock { $0 = max($0, operation) } }

    func prepare(_ text: String, operation: Int, deadline: Double) throws -> JSON {
        guard operation > latest, ended.withLock({ operation > $0 }),
              Date().timeIntervalSince1970 * 1000 < deadline else { throw HelperError("clipboard preparation expired") }
        latest = operation
        current?.expiry.cancel()
        let transaction = clipboard.write(text)
        let remaining = max(0, deadline - Date().timeIntervalSince1970 * 1000)
        let expiry = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(remaining)) } catch { return }
            self?.finish(operation)
        }
        current = (operation, transaction, expiry)
        return ["transaction": .number(Double(transaction))]
    }

    func finish(_ operation: Int) {
        end(operation)
        guard let prepared = current, prepared.operation == operation else { return }
        prepared.expiry.cancel()
        current = nil
        clipboard.restore(after: prepared.transaction)
    }
}
