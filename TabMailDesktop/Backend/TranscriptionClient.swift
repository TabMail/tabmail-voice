// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

enum TranscriptionError: LocalizedError, Equatable {
    case unauthorized
    case subscriptionRequired
    case accountSetupRequired
    case accessDenied
    case rateLimited
    case recordingTooLong
    case failed(status: Int)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .unauthorized: "Your TabMail session has ended. Sign in again in Settings."
        case .subscriptionRequired: "Dictation needs an active TabMail subscription."
        case .accountSetupRequired: "Finish setting up your TabMail account at tabmail.ai."
        case .accessDenied: "This account can't use this TabMail server."
        case .rateLimited: "Too many dictations right now. Try again in a moment."
        case .recordingTooLong: "That recording was too long to transcribe."
        case .failed: "Transcription failed. Please try again."
        case .invalidResponse: "Transcription returned an unexpected response."
        }
    }
}

/// Calls the TabMail backend's `POST /dictation/transcribe` (OpenRouter STT behind it).
struct TranscriptionClient: Sendable {
    let baseURL: URL
    let clientVersion: String
    let transport: HTTPTransport

    init(
        baseURL: URL,
        clientVersion: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
        transport: @escaping HTTPTransport = HTTP.live
    ) {
        self.baseURL = baseURL
        self.clientVersion = clientVersion
        self.transport = transport
    }

    func transcribe(wav: Data, accessToken: String) async throws -> String {
        var request = URLRequest(url: baseURL.appending(path: DictationConfig.transcribePath))
        request.httpMethod = "POST"
        request.timeoutInterval = DictationConfig.transcriptionRequestTimeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(DictationConfig.clientType, forHTTPHeaderField: "X-Client-Type")
        request.setValue(clientVersion, forHTTPHeaderField: "X-Client-Version")
        request.httpBody = try JSONEncoder().encode(Body(audio: wav.base64EncodedString(), format: "wav"))

        let (data, response) = try await transport(request)
        guard let http = response as? HTTPURLResponse else { throw TranscriptionError.invalidResponse }
        guard http.statusCode == 200 else {
            throw Self.error(status: http.statusCode, code: (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error)
        }
        guard let result = try? JSONDecoder().decode(ResultBody.self, from: data) else {
            throw TranscriptionError.invalidResponse
        }
        return result.text
    }

    static func error(status: Int, code: String?) -> TranscriptionError {
        switch (status, code) {
        case (401, _): .unauthorized
        case (402, _): .subscriptionRequired
        case (403, "consent_required"): .accountSetupRequired
        case (403, _): .accessDenied
        case (429, _): .rateLimited
        case (400, "audio_too_large"): .recordingTooLong
        default: .failed(status: status)
        }
    }

    private struct Body: Encodable {
        let audio: String
        let format: String
    }

    private struct ResultBody: Decodable {
        let text: String
    }

    private struct ErrorBody: Decodable {
        let error: String?
    }
}
