// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

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
        guard let http = response as? HTTPURLResponse else { throw BackendError.invalidResponse }
        guard http.statusCode == 200 else {
            throw BackendError(status: http.statusCode, code: (try? JSONDecoder().decode(BackendError.Body.self, from: data))?.error)
        }
        guard let result = try? JSONDecoder().decode(ResultBody.self, from: data) else {
            throw BackendError.invalidResponse
        }
        return result.text
    }

    private struct Body: Encodable {
        let audio: String
        let format: String
    }

    private struct ResultBody: Decodable {
        let text: String
    }
}
