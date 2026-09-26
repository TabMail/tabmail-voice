// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import Security

/// Where the signed-in session is kept.
protocol SessionStoring: Sendable {
    func load() -> TabMailSession?
    func save(_ session: TabMailSession) throws
    func clear()
}

/// Keychain-backed session storage (one generic-password item).
struct KeychainSessionStore: SessionStoring {
    enum StoreError: Error {
        case keychain(OSStatus)
    }

    let service: String
    private let account = "session"

    init(service: String = DictationConfig.keychainService) {
        self.service = service
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func load() -> TabMailSession? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            if status != errSecItemNotFound {
                Log.error("KeychainSessionStore: load failed with status \(status)")
            }
            return nil
        }
        return try? JSONDecoder().decode(TabMailSession.self, from: data)
    }

    func save(_ session: TabMailSession) throws {
        let data = try JSONEncoder().encode(session)
        let update = [kSecValueData as String: data]
        var status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw StoreError.keychain(status) }
    }

    func clear() {
        let status = SecItemDelete(baseQuery as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            Log.error("KeychainSessionStore: delete failed with status \(status)")
        }
    }
}
