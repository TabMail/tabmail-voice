// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// Which signed-in accounts may use debug mode: the same accounts as iOS `DebugModeManager`.
enum DebugAccess {
    /// Every account on this domain is allowed.
    private static let allowedEmailDomain = "tabmail.ai"

    /// Individual accounts outside `allowedEmailDomain`. Keep short: each one bypasses the domain check.
    private static let allowedEmails: Set<String> = [
        "tabmail.ai@gmail.com",
    ]

    static func allows(_ email: String?) -> Bool {
        guard let email = email?.lowercased() else { return false }
        return email.hasSuffix("@\(allowedEmailDomain)") || allowedEmails.contains(email)
    }
}
