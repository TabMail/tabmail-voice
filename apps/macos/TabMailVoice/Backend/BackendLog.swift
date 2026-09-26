// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// How a request to the backend and its reply read in the debug log file (`Log.content`,
/// ADR-DESK-015): everything as sent and as received, except the access token.
enum BackendLog {
    /// Stands in for the access token in a logged `Authorization` header.
    static let maskedAuthorization = "Bearer <access token, not logged>"

    /// The request as sent: method, URL, headers (the access token masked) and `body`, else the
    /// request's own body.
    static func request(_ request: URLRequest, body: String? = nil) -> String {
        let headers = (request.allHTTPHeaderFields ?? [:])
            .map { name, value in (name, name.caseInsensitiveCompare("Authorization") == .orderedSame ? maskedAuthorization : value) }
        let sent = body ?? request.httpBody.map { String(decoding: $0, as: UTF8.self) } ?? ""
        return "\(request.httpMethod ?? "GET") \(request.url?.absoluteString ?? "-")\n"
            + lines(headers) + "\n\n" + sent
    }

    /// The reply as received: status, headers (Cloudflare's `cf-ray` finds the request in the
    /// backend's logs) and the raw body.
    static func response(_ response: URLResponse, data: Data) -> String {
        let body = String(decoding: data, as: UTF8.self)
        guard let http = response as? HTTPURLResponse else { return "(not an HTTP response)\n\n" + body }
        let headers = http.allHeaderFields.map { name, value in ("\(name)", "\(value)") }
        return "HTTP \(http.statusCode)\n" + lines(headers) + "\n\n" + body
    }

    private static func lines(_ headers: [(String, String)]) -> String {
        headers.sorted { $0.0.lowercased() < $1.0.lowercased() }.map { "\($0.0): \($0.1)" }.joined(separator: "\n")
    }
}
