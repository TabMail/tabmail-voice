// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// A failed TabMail backend call, with the message the overlay shows for it.
enum BackendError: LocalizedError, Equatable {
    case unauthorized
    case subscriptionRequired
    case accountSetupRequired
    case accessDenied
    case rateLimited
    case recordingTooLong
    case failed(status: Int)
    case invalidResponse

    /// From an HTTP error status and the `error` code of its JSON body.
    init(status: Int, code: String?) {
        self = switch (status, code) {
        case (401, _): .unauthorized
        case (402, _): .subscriptionRequired
        case (403, "consent_required"): .accountSetupRequired
        case (403, _): .accessDenied
        case (429, _): .rateLimited
        case (400, "audio_too_large"): .recordingTooLong
        default: .failed(status: status)
        }
    }

    var errorDescription: String? {
        switch self {
        case .unauthorized: "Your TabMail session has ended. Sign in again in Settings."
        case .subscriptionRequired: "Dictation needs an active TabMail subscription."
        case .accountSetupRequired: "Finish setting up your TabMail account at tabmail.ai."
        case .accessDenied: "This account can't use this TabMail server."
        case .rateLimited: "Too many dictations right now. Try again in a moment."
        case .recordingTooLong: "That recording was too long to transcribe."
        case .failed: "Dictation failed. Please try again."
        case .invalidResponse: "TabMail returned an unexpected response."
        }
    }

    /// The JSON body of an HTTP error.
    struct Body: Decodable {
        let error: String?
    }
}
