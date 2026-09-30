// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import CoreServices
import Foundation
import UniformTypeIdentifiers
import VoiceHelperSupport

/// What the app's `files_search` asks Spotlight for (ADR-DESK-026).
struct SpotlightQuery: Equatable, Sendable {
    /// The kinds of item the backend's `files_search` offers, by the content type each must be.
    enum Kind: String, CaseIterable, Sendable {
        case any, document, pdf, image, presentation, spreadsheet, folder, email

        /// Content types an item's type tree must hold one of; none for `any`.
        var contentTypes: [String] {
            switch self {
            case .any: []
            case .document: [UTType.compositeContent.identifier, UTType.text.identifier]
            case .pdf: [UTType.pdf.identifier]
            case .image: [UTType.image.identifier]
            case .presentation: [UTType.presentation.identifier]
            case .spreadsheet: [UTType.spreadsheet.identifier]
            case .folder: [UTType.folder.identifier]
            case .email: [UTType.emailMessage.identifier]
            }
        }
    }

    var words: [String]
    var kind = Kind.any
    var changedAfter: Date?
    var changedBefore: Date?

    /// The Spotlight query: every word in the item's name or content, or an email's subject or
    /// sender, ignoring case and accents; then the kind and the dates.
    var queryString: String {
        var clauses = words.map { word in
            let word = Self.escaped(word)
            let fields = [
                "kMDItemDisplayName == \"*\(word)*\"cd",
                "kMDItemTextContent == \"\(word)*\"cdw",
                "kMDItemSubject == \"*\(word)*\"cd",
                "kMDItemAuthors == \"*\(word)*\"cd",
                "kMDItemAuthorEmailAddresses == \"*\(word)*\"cd",
            ]
            return "(" + fields.joined(separator: " || ") + ")"
        }
        if !kind.contentTypes.isEmpty {
            clauses.append("(" + kind.contentTypes.map { "kMDItemContentTypeTree == \"\($0)\"" }.joined(separator: " || ") + ")")
        }
        if let changedAfter { clauses.append("kMDItemFSContentChangeDate >= $time.iso(\(Self.iso(changedAfter)))") }
        if let changedBefore { clauses.append("kMDItemFSContentChangeDate < $time.iso(\(Self.iso(changedBefore)))") }
        return clauses.joined(separator: " && ")
    }

    /// `text` inside a quoted Spotlight value: a quote or backslash can't end it, and `*` matches only itself.
    static func escaped(_ text: String) -> String {
        text.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "*", with: "\\*")
    }

    private static func iso(_ date: Date) -> String {
        date.formatted(.iso8601)
    }
}

/// An item Spotlight found: a file or folder, or an Apple Mail message.
struct FoundItem: Equatable, Sendable {
    var path: String
    var name: String
    /// What the Finder calls its kind ("PDF document").
    var kind: String
    var changed: Date?
    /// For an email: its subject and senders.
    var subject: String?
    var authors: [String] = []

    var isEmail: Bool {
        UTType(filenameExtension: (path as NSString).pathExtension)?.conforms(to: .emailMessage) == true
    }

    /// What the app receives: its change time in milliseconds since 1970.
    var json: JSON {
        [
            "path": .string(path), "name": .string(name), "kind": .string(kind), "changed": changed.map(EventWire.json) ?? .null,
            "subject": subject.map(JSON.string) ?? .null, "authors": .array(authors.map(JSON.string)), "isEmail": .bool(isEmail),
        ]
    }
}

/// Spotlight and the Finder for the Answer tool's Files tools (ADR-DESK-026): no permission is asked,
/// and a failure goes back by name, so a file's name in the system's error never reaches a log.
enum Files {
    /// Why a request can't be carried out, sent as the error's message; the app knows each by name.
    enum Failure: String, Error {
        case searchFailed
        case openFailed

        var helperError: HelperError { HelperError(rawValue) }
    }

    /// Items in the user's home folder matching `query`, most recently changed first, at most `limit`.
    /// `MDQuery` runs synchronously for seconds, so on a Dispatch queue: on a task it would hold one of
    /// the few threads every other request's task runs on (the screen read, the microphone). It
    /// gathers at most `HelperConfig.filesSearchScanLimit` items, then keeps the newest.
    static func search(_ query: SpotlightQuery, limit: Int) async throws -> [FoundItem] {
        let text = query.queryString
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(with: Result { newest(try run(text, scanLimit: HelperConfig.filesSearchScanLimit), limit: limit) })
            }
        }
    }

    /// The `limit` most recently changed of `items`, newest first; one with no change time last.
    static func newest(_ items: [FoundItem], limit: Int) -> [FoundItem] {
        Array(items.sorted { ($0.changed ?? .distantPast) > ($1.changed ?? .distantPast) }.prefix(limit))
    }

    /// Opens the item at `path` in its usual app, or shows it in the Finder: with `reveal`, or when
    /// `OpenPolicy` says it can run something. True when it was opened. An item that isn't there
    /// fails: the Finder shows nothing for it and says nothing.
    @MainActor
    static func open(_ path: String, reveal: Bool, opener: FileOpener = .workspace) async throws -> Bool {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else { throw Failure.openFailed.helperError }
        guard OpenPolicy.opens(url, reveal: reveal) else {
            opener.reveal(url)
            return false
        }
        do {
            try await opener.open(url)
        } catch {
            throw Failure.openFailed.helperError
        }
        return true
    }

    private static func run(_ text: String, scanLimit: Int) throws -> [FoundItem] {
        guard let query = MDQueryCreate(kCFAllocatorDefault, text as CFString, nil, nil) else { throw Failure.searchFailed.helperError }
        MDQuerySetSearchScope(query, [kMDQueryScopeHome] as CFArray, 0)
        MDQuerySetMaxCount(query, scanLimit)
        guard MDQueryExecute(query, CFOptionFlags(kMDQuerySynchronous.rawValue)) else { throw Failure.searchFailed.helperError }
        return (0..<MDQueryGetResultCount(query)).compactMap { index in
            guard let raw = MDQueryGetResultAtIndex(query, index) else { return nil }
            return item(Unmanaged<MDItem>.fromOpaque(raw).takeUnretainedValue())
        }
    }

    private static func item(_ item: MDItem) -> FoundItem? {
        func value<T>(_ key: CFString, as _: T.Type) -> T? { MDItemCopyAttribute(item, key) as? T }
        guard let path = value(kMDItemPath, as: String.self) else { return nil }
        return FoundItem(
            path: path,
            name: value(kMDItemDisplayName, as: String.self) ?? (path as NSString).lastPathComponent,
            kind: value(kMDItemKind, as: String.self) ?? "",
            changed: value(kMDItemFSContentChangeDate, as: Date.self),
            subject: value(kMDItemSubject, as: String.self),
            authors: value(kMDItemAuthors, as: [String].self) ?? []
        )
    }
}

/// How `Files.open` opens an item and shows one in the Finder: the workspace's, or a test's stand-in
/// that opens and shows nothing.
struct FileOpener: Sendable {
    var open: @MainActor @Sendable (URL) async throws -> Void
    var reveal: @MainActor @Sendable (URL) -> Void

    static let workspace = FileOpener(
        open: { _ = try await NSWorkspace.shared.open($0, configuration: NSWorkspace.OpenConfiguration()) },
        reveal: { NSWorkspace.shared.activateFileViewerSelecting([$0]) }
    )
}

/// Which items `file_open` opens rather than only shows in the Finder: documents, text, pictures,
/// media, email and plain folders. Anything that can run something (apps, scripts, installers,
/// macro-enabled documents, Terminal settings, links to other items, and a symbolic link or alias
/// whatever its name) is only shown, so a path planted on screen or in a file can at most open a
/// document.
enum OpenPolicy {
    private static let opened: [UTType] = [
        .pdf, .image, .audiovisualContent, .presentation, .spreadsheet, .compositeContent, .text, .emailMessage,
    ]
    /// What runs or installs something: source code, scripts included (`public.script` conforms to
    /// `public.source-code`), executables (among them macro-enabled Office documents, `.xlsm` and the
    /// like, which are also composite content), and XML that launches a Java app or installs a
    /// configuration profile. Apps, installers, disk images and links are none of the `opened` types,
    /// so need no entry.
    private static let shownOnly: [UTType] = [.sourceCode, .executable] + [
        "com.sun.java-web-start", "com.apple.mobileconfig", "com.apple.configprofile", "com.apple.provisionprofile",
    ].compactMap { UTType($0) }
    /// The documents kept as packages (a folder the Finder shows as one item) that open: rich text with
    /// attachments, and Pages, Keynote and Numbers documents. Every other package is only shown: most
    /// are composite content too, among them Xcode projects, workspaces, toolchains and playgrounds,
    /// Swift packages and app preference bundles, several of which run or install something as they open.
    private static let openedPackages: [UTType] = [.rtfd] + [
        "com.apple.iwork.pages.pages", "com.apple.iwork.keynote.key", "com.apple.iwork.numbers.numbers",
    ].compactMap { UTType($0) }

    /// Whether `file_open` opens `url` rather than shows it: never when asked to show it (`reveal`).
    static func opens(_ url: URL, reveal: Bool) -> Bool {
        !reveal && opens(url)
    }

    /// By the name's extension, as Launch Services picks the app that opens it; that also works for a
    /// Mail message this helper may not read (its folder needs Full Disk Access). A symbolic link or
    /// a Finder alias opens what it points to, whatever its own name says, so is only shown. A package
    /// is typed as one (`.rtfd` names no file type, only a package type) and opens only when it is one
    /// of `openedPackages`.
    static func opens(_ url: URL) -> Bool {
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey, .isAliasFileKey])
        if values?.isAliasFile == true { return false }
        if values?.isDirectory == true {
            guard values?.isPackage == true else { return true }
            guard let type = UTType(filenameExtension: url.pathExtension, conformingTo: .package) else { return false }
            return openedPackages.contains { type.conforms(to: $0) }
        }
        guard let type = UTType(filenameExtension: url.pathExtension) else { return false }
        return opens(type)
    }

    static func opens(_ type: UTType) -> Bool {
        opened.contains { type.conforms(to: $0) } && !shownOnly.contains { type.conforms(to: $0) }
    }
}
