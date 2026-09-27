// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import os

/// A request the app could not have its answer to: the message goes back as the reply's error.
public struct HelperError: Error, Sendable, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

/// The helper's side of its pipe to the app: requests `{"id", "method", "params"}` arrive one a line
/// on stdin; replies `{"id", "result"}` or `{"id", "error": {"message"}}` and events
/// `{"event", ...}` leave one a line on stdout. The helper exits when stdin closes, so it never
/// outlives the app.
public final class HelperChannel: Sendable {
    public typealias Handler = @Sendable (JSON) async throws -> JSON

    private let handlers: OSAllocatedUnfairLock<[String: Handler]> = .init(initialState: [:])
    private let output: @Sendable (Data) -> Void

    /// `output` receives each line, newline included; stdout by default.
    public init(output: @escaping @Sendable (Data) -> Void = HelperChannel.standardOutput) {
        self.output = output
    }

    public static let standardOutput: @Sendable (Data) -> Void = { line in
        standardOutputLock.withLock { FileHandle.standardOutput.write(line) }
    }
    private static let standardOutputLock = OSAllocatedUnfairLock()

    /// Answers `method` with `handler`'s result.
    public func on(_ method: String, _ handler: @escaping Handler) {
        handlers.withLock { $0[method] = handler }
    }

    /// Sends an event the app did not ask for.
    public func emit(_ event: String, _ fields: [String: JSON] = [:]) {
        var message = fields
        message["event"] = .string(event)
        send(.object(message))
    }

    /// Handles one request line. Internal to the package's tests; `run()` feeds it stdin.
    public func handle(line: Data) async {
        guard let request = try? JSONDecoder().decode(JSON.self, from: line),
              let id = request["id"], let method = request["method"]?.string else {
            HelperLog.debug("HelperChannel: unreadable request (\(line.count) bytes)")
            return
        }
        guard let handler = handlers.withLock({ $0[method] }) else {
            send(["id": id, "error": ["message": .string("unknown method \(method)")]])
            return
        }
        do {
            let result = try await handler(request["params"] ?? .null)
            send(["id": id, "result": result])
        } catch let error as HelperError {
            send(["id": id, "error": ["message": .string(error.message)]])
        } catch {
            send(["id": id, "error": ["message": .string(String(describing: error))]])
        }
    }

    /// Reads stdin on its own thread, each request handled in its own task, and exits the process
    /// when stdin closes. Returns at once; the caller runs the main run loop.
    public func start() {
        let thread = Thread { [self] in
            let input = FileHandle.standardInput
            var buffer = Data()
            while true {
                let chunk = input.availableData
                if chunk.isEmpty { exit(0) }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 0x0A) {
                    let line = buffer[buffer.startIndex..<newline]
                    buffer = Data(buffer[(newline + 1)...])
                    guard !line.isEmpty else { continue }
                    let request = Data(line)
                    Task { await self.handle(line: request) }
                }
            }
        }
        thread.name = "HelperChannel.stdin"
        thread.start()
    }

    private func send(_ message: JSON) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard var line = try? encoder.encode(message) else { return }
        line.append(0x0A)
        output(line)
    }
}
