// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// A Supabase session, in the wire shape GoTrue returns (same model as iOS `TabMailSession`).
struct TabMailSession: Codable, Equatable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Int
    let userId: String
    let userEmail: String

    init(accessToken: String, refreshToken: String, expiresAt: Int, userId: String, userEmail: String) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.userId = userId
        self.userEmail = userEmail
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try container.decode(String.self, forKey: .accessToken)
        refreshToken = try container.decode(String.self, forKey: .refreshToken)
        expiresAt = try container.decode(Int.self, forKey: .expiresAt)
        let user = try container.decode(UserInfo.self, forKey: .user)
        userId = user.id
        userEmail = user.email ?? ""
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(accessToken, forKey: .accessToken)
        try container.encode(refreshToken, forKey: .refreshToken)
        try container.encode(expiresAt, forKey: .expiresAt)
        try container.encode(UserInfo(id: userId, email: userEmail), forKey: .user)
    }

    func expires(within seconds: Int, now: Date = Date()) -> Bool {
        expiresAt <= Int(now.timeIntervalSince1970) + seconds
    }

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresAt = "expires_at"
        case user
    }

    private struct UserInfo: Codable {
        let id: String
        let email: String?
    }
}
