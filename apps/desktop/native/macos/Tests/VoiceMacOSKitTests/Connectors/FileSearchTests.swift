// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import os
import Testing
import VoiceHelperSupport
@testable import VoiceMacOSKit

/// Spotlight and the Finder as `voice-macos` runs them for the app's Files tools (ADR-DESK-026), from
/// the Swift `FilesToolsTests`: the query Spotlight is asked, what crosses the wire, and what is
/// opened rather than only shown. Nothing is opened or shown; the one real search looks for a word
/// no file holds.
struct FileSearchTests {
    private func word(_ word: String) -> String {
        "(kMDItemDisplayName == \"*\(word)*\"cd || kMDItemTextContent == \"\(word)*\"cdw || kMDItemSubject == \"*\(word)*\"cd"
            + " || kMDItemAuthors == \"*\(word)*\"cd || kMDItemAuthorEmailAddresses == \"*\(word)*\"cd)"
    }

    /// Every word must be in the name or content, or an email's subject or sender; then the kind and
    /// the dates, as Spotlight's UTC times.
    @Test
    func theQueryNeedsEveryWordThenTheKindAndDates() {
        let query = SpotlightQuery(words: ["tax", "return"], kind: .document, changedAfter: Date(timeIntervalSince1970: 0), changedBefore: Date(timeIntervalSince1970: 86_400))

        #expect(query.queryString == [
            word("tax"), word("return"),
            "(kMDItemContentTypeTree == \"public.composite-content\" || kMDItemContentTypeTree == \"public.text\")",
            "kMDItemFSContentChangeDate >= $time.iso(1970-01-01T00:00:00Z)",
            "kMDItemFSContentChangeDate < $time.iso(1970-01-02T00:00:00Z)",
        ].joined(separator: " && "))
        #expect(SpotlightQuery(words: ["tax"]).queryString == word("tax"))
    }

    /// A quote, backslash or star in a word stays inside its value.
    @Test
    func aWordCannotEndItsValue() {
        #expect(SpotlightQuery.escaped(#"a"b\c*"#) == #"a\"b\\c\*"#)
        #expect(SpotlightQuery(words: [#"a"b"#]).queryString == word(#"a\"b"#))
    }

    /// Each kind the backend offers maps to its content types.
    @Test
    func eachKindHasItsContentTypes() {
        #expect(SpotlightQuery.Kind.allCases.map(\.rawValue) == ["any", "document", "pdf", "image", "presentation", "spreadsheet", "folder", "email"])
        #expect(SpotlightQuery.Kind.allCases.map(\.contentTypes) == [
            [], ["public.composite-content", "public.text"], ["com.adobe.pdf"], ["public.image"], ["public.presentation"],
            ["public.spreadsheet"], ["public.folder"], ["public.email-message"],
        ])
    }

    /// Spotlight itself accepts every kind, both dates and hostile words: a word nothing holds finds
    /// nothing rather than failing.
    @Test(arguments: SpotlightQuery.Kind.allCases)
    func spotlightAcceptsTheQuery(kind: SpotlightQuery.Kind) async throws {
        let nothing = "tabmail\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        let query = SpotlightQuery(words: [nothing, #"a"b\c*"#], kind: kind, changedAfter: Date(timeIntervalSince1970: 0), changedBefore: Date())

        #expect(try await Files.search(query, limit: 5).isEmpty)
    }

    /// A search that matches nearly everything stays in the home folder, gathers at most
    /// `filesSearchScanLimit` items (without the cap it scans for minutes), and gives the newest first,
    /// no more than asked. Read-only, and only counts and booleans are checked, so a failure prints no
    /// path of the user's.
    @Test(.timeLimit(.minutes(1)))
    func aBroadSearchStaysBoundedInTheHomeFolderNewestFirst() async throws {
        let home = NSHomeDirectory() + "/"

        let all = try await Files.search(SpotlightQuery(words: ["e"]), limit: .max)
        let few = try await Files.search(SpotlightQuery(words: ["e"]), limit: 3)

        #expect(all.count <= HelperConfig.filesSearchScanLimit)
        #expect(all.allSatisfy { $0.path.hasPrefix(home) })
        let changed = all.map { $0.changed ?? .distantPast }
        #expect(zip(changed, changed.dropFirst()).allSatisfy { $0 >= $1 })
        #expect(few.count <= 3)
    }

    /// An item goes to the app with its change time in milliseconds (null when unknown), and says
    /// whether it is an email by its name's extension.
    @Test
    func anItemCrossesTheWire() {
        let changed = Date(timeIntervalSince1970: (Date().timeIntervalSince1970).rounded())
        let pdf = FoundItem(path: "/Users/example/Documents/Tax return.pdf", name: "Tax return.pdf", kind: "PDF document", changed: changed)
        let email = FoundItem(path: "/Users/example/Library/Mail/V10/1.emlx", name: "1.emlx", kind: "Mail Message", subject: "Your tax return", authors: ["Sam Example"])

        #expect(pdf.json == [
            "path": "/Users/example/Documents/Tax return.pdf", "name": "Tax return.pdf", "kind": "PDF document",
            "changed": .number(changed.timeIntervalSince1970 * 1000), "subject": nil, "authors": [], "isEmail": false,
        ])
        #expect(email.json == [
            "path": "/Users/example/Library/Mail/V10/1.emlx", "name": "1.emlx", "kind": "Mail Message",
            "changed": nil, "subject": "Your tax return", "authors": ["Sam Example"], "isEmail": true,
        ])
    }

    /// The newest items Spotlight gathered, up to the limit; one with no change time goes last.
    @Test
    func theNewestItemsAreKept() {
        let now = Date()
        let item = { (name: String, age: TimeInterval?) in
            FoundItem(path: "/Users/example/\(name)", name: name, kind: "Plain Text", changed: age.map { now.addingTimeInterval(-$0) })
        }
        let items = [item("unknown.txt", nil), item("old.txt", 7200), item("new.txt", 60), item("mid.txt", 3600)]

        #expect(Files.newest(items, limit: 3).map(\.name) == ["new.txt", "mid.txt", "old.txt"])
        #expect(Files.newest(items, limit: 10).map(\.name) == ["new.txt", "mid.txt", "old.txt", "unknown.txt"])
    }

    /// Asked to show it, even a document is only shown.
    @Test
    func revealOnlyShows() {
        let pdf = URL(fileURLWithPath: "/tmp/example.pdf")

        #expect(OpenPolicy.opens(pdf, reveal: false))
        #expect(!OpenPolicy.opens(pdf, reveal: true))
    }

    @Test(arguments: ["pdf", "docx", "pages", "key", "numbers", "xlsx", "pptx", "txt", "md", "rtf", "csv", "xml", "html", "png", "mov", "mp3", "emlx", "eml"])
    func documentsMediaAndEmailOpen(fileExtension: String) {
        #expect(OpenPolicy.opens(URL(fileURLWithPath: "/tmp/example.\(fileExtension)")))
    }

    @Test(arguments: ["command", "tool", "sh", "zsh", "py", "js", "scpt", "applescript", "c", "jnlp", "xlsm", "xltm", "docm", "dotm", "pptm", "ppsm", "potm", "mobileconfig", "configprofile", "provisionprofile", "app", "pkg", "terminal", "webloc", "fileloc", "inetloc", "shortcut", "plist", "dmg", "zip", "workflow", ""])
    func whatCanRunSomethingIsOnlyShown(fileExtension: String) {
        #expect(!OpenPolicy.opens(URL(fileURLWithPath: fileExtension.isEmpty ? "/tmp/example" : "/tmp/example.\(fileExtension)")))
    }

    /// A plain folder opens in the Finder; an app, a folder too, does not.
    @Test
    func aFolderOpensButAnAppBundleDoesNot() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("FileSearchTests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("Receipts")
        let app = root.appendingPathComponent("Example.app")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents"), withIntermediateDirectories: true)

        #expect(OpenPolicy.opens(folder))
        #expect(!OpenPolicy.opens(app))
    }

    /// Each failure goes to the app by the name it knows (`FileStoreFailure`'s kinds).
    @Test
    func failuresGoByName() {
        #expect(Files.Failure.searchFailed.helperError == HelperError("searchFailed"))
        #expect(Files.Failure.openFailed.helperError == HelperError("openFailed"))
    }
}

/// The Finder standing in for `Files.open`: records what it was asked to open and to show, and opens
/// and shows nothing.
@MainActor
final class FakeFileOpener {
    private(set) var opened: [URL] = []
    private(set) var revealed: [URL] = []
    /// Whether opening fails, as a missing app or a refusal would.
    var fails = false

    var opener: FileOpener {
        FileOpener(
            open: { url in
                if self.fails { throw CocoaError(.fileReadNoPermission) }
                self.opened.append(url)
            },
            reveal: { self.revealed.append($0) }
        )
    }
}

/// `Files.open` over items made for the test and a stand-in Finder (nothing is opened or shown): what
/// is opened, what only shown, and what fails.
@MainActor
struct FilesOpenTests {
    private let root = FileManager.default.temporaryDirectory.appendingPathComponent("FilesOpenTests-\(UUID().uuidString)")

    /// A document, a script, an app, a macro-enabled spreadsheet, and a symbolic link and a Finder
    /// alias named like documents that point at the script; document packages, other packages, and a
    /// plain folder.
    private func makeItems() throws {
        let files = FileManager.default
        for folder in ["Example.app/Contents", "Notes.rtfd", "Report.pages", "Slides.key", "Budget.numbers", "Example.playground", "Example.xcodeproj", "Example.xcworkspace", "Example.swiftpm", "Example.xctoolchain", "Taxes"] {
            try files.createDirectory(at: root.appendingPathComponent(folder), withIntermediateDirectories: true)
        }
        for name in ["Report.pdf", "run.command", "Budget.xlsm"] {
            try Data("example".utf8).write(to: root.appendingPathComponent(name))
        }
        let script = root.appendingPathComponent("run.command")
        try files.createSymbolicLink(at: root.appendingPathComponent("Invoice.pdf"), withDestinationURL: script)
        let bookmark = try script.bookmarkData(options: .suitableForBookmarkFile, includingResourceValuesForKeys: nil, relativeTo: nil)
        try URL.writeBookmarkData(bookmark, to: root.appendingPathComponent("Statement.pdf"))
    }

    /// A document opens and is not shown; asked to show it, it is shown and not opened.
    @Test(arguments: [false, true])
    func aDocumentOpensUnlessAskedToShowIt(reveal: Bool) async throws {
        try makeItems()
        defer { try? FileManager.default.removeItem(at: root) }
        let finder = FakeFileOpener()
        let document = root.appendingPathComponent("Report.pdf")

        let opened = try await Files.open(document.path, reveal: reveal, opener: finder.opener)

        #expect(opened == !reveal)
        #expect(finder.opened == (reveal ? [] : [document]))
        #expect(finder.revealed == (reveal ? [document] : []))
    }

    /// A document kept as a package, and a plain folder, open (a real `.rtfd` was only shown, and the
    /// model told it could run something).
    @Test(arguments: ["Notes.rtfd", "Report.pages", "Slides.key", "Budget.numbers", "Taxes"])
    func aDocumentPackageOrFolderOpens(name: String) async throws {
        try makeItems()
        defer { try? FileManager.default.removeItem(at: root) }
        let finder = FakeFileOpener()
        let item = root.appendingPathComponent(name)

        let opened = try await Files.open(item.path, reveal: false, opener: finder.opener)

        #expect(opened)
        #expect(finder.opened == [item])
        #expect(finder.revealed.isEmpty)
    }

    /// What can run something, and a link or alias whatever its name, is shown and never opened; so is
    /// any other package, a developer project that runs code as it opens among them.
    @Test(arguments: ["run.command", "Example.app", "Budget.xlsm", "Invoice.pdf", "Statement.pdf", "Example.playground", "Example.xcodeproj", "Example.xcworkspace", "Example.swiftpm", "Example.xctoolchain"])
    func whatCanRunSomethingIsShownNeverOpened(name: String) async throws {
        try makeItems()
        defer { try? FileManager.default.removeItem(at: root) }
        let finder = FakeFileOpener()
        let item = root.appendingPathComponent(name)

        let opened = try await Files.open(item.path, reveal: false, opener: finder.opener)

        #expect(!opened)
        #expect(finder.opened.isEmpty)
        #expect(finder.revealed == [item])
    }

    /// An item that isn't there, or that fails to open, fails by name; a missing one is neither opened
    /// nor shown.
    @Test(arguments: [false, true])
    func aMissingItemFails(reveal: Bool) async throws {
        try makeItems()
        defer { try? FileManager.default.removeItem(at: root) }
        let finder = FakeFileOpener()

        await #expect(throws: Files.Failure.openFailed.helperError) {
            try await Files.open(root.appendingPathComponent("Moved.pdf").path, reveal: reveal, opener: finder.opener)
        }
        #expect(finder.opened.isEmpty && finder.revealed.isEmpty)
    }

    @Test
    func aFailedOpenFailsByName() async throws {
        try makeItems()
        defer { try? FileManager.default.removeItem(at: root) }
        let finder = FakeFileOpener()
        finder.fails = true

        await #expect(throws: Files.Failure.openFailed.helperError) {
            try await Files.open(root.appendingPathComponent("Report.pdf").path, reveal: false, opener: finder.opener)
        }
        #expect(finder.revealed.isEmpty)
    }

    /// `voice-macos`'s `fileOpen` carries its path and `reveal` to `Files.open` and answers whether the
    /// item was opened.
    @Test
    func theRequestReachesTheFinder() async throws {
        try makeItems()
        defer { try? FileManager.default.removeItem(at: root) }
        let finder = FakeFileOpener()
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let service = MacService.register(
            on: channel, eventStore: EventKitStore(store: FakeEventStore(), status: { _ in .fullAccess }),
            contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }), fileOpener: finder.opener
        )
        let document = root.appendingPathComponent("Report.pdf")
        let path = String(data: try JSONEncoder().encode(document.path), encoding: .utf8) ?? ""
        for (id, reveal) in [(1, false), (2, true)] {
            await channel.handle(line: Data(#"{"id":\#(id),"method":"fileOpen","params":{"path":\#(path),"reveal":\#(reveal)}}"#.utf8))
        }

        let replies = try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        #expect(replies.map { ($0["result"] as? [String: Any])?["opened"] as? Bool } == [true, false])
        #expect(finder.opened == [document])
        #expect(finder.revealed == [document])
        withExtendedLifetime(service) {}
    }

    /// Registers `voice-macos`'s requests over `finder` and a stand-in Spotlight that records each
    /// search and finds `found`; returns the channel, the searches, the replies and the service.
    private func service(finder: FakeFileOpener, found: [FoundItem] = []) -> (HelperChannel, OSAllocatedUnfairLock<[(SpotlightQuery, Int)]>, () throws -> [[String: Any]], AnyObject) {
        let lines = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let searches = OSAllocatedUnfairLock<[(SpotlightQuery, Int)]>(initialState: [])
        let channel = HelperChannel(output: { line in lines.withLock { $0.append(line) } })
        let service = MacService.register(
            on: channel, eventStore: EventKitStore(store: FakeEventStore(), status: { _ in .fullAccess }),
            contactStore: ContactsFrameworkStore(store: FakeContactStore(), status: { _ in .authorized }),
            fileSearch: { query, limit in
                searches.withLock { $0.append((query, limit)) }
                return found
            },
            fileOpener: finder.opener
        )
        let replies = { try lines.withLock { $0 }.map { try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any]) } }
        return (channel, searches, replies, service)
    }

    /// `voice-macos`'s `filesSearch` searches for what the app sends, as the app sends it: every word,
    /// the kind, each date bound as itself, and the limit; the items found come back.
    @Test
    func theSearchRequestReachesSpotlight() async throws {
        let now = Date()
        let after = Date(timeIntervalSince1970: ((now.timeIntervalSince1970 - 7 * 86_400) * 1000).rounded() / 1000)
        let before = Date(timeIntervalSince1970: (now.timeIntervalSince1970 * 1000).rounded() / 1000)
        let item = FoundItem(path: "/Users/example/Documents/Tax return.pdf", name: "Tax return.pdf", kind: "PDF document", changed: before)
        let (channel, searches, replies, service) = service(finder: FakeFileOpener(), found: [item])

        await channel.handle(line: Data(#"{"id":1,"method":"filesSearch","params":{"words":["tax","return"],"kind":"pdf","changedAfter":\#(after.timeIntervalSince1970 * 1000),"changedBefore":\#(before.timeIntervalSince1970 * 1000),"limit":11}}"#.utf8))
        await channel.handle(line: Data(#"{"id":2,"method":"filesSearch","params":{"words":["tax"],"kind":"any","changedAfter":null,"changedBefore":null,"limit":3}}"#.utf8))

        let recorded = searches.withLock { $0 }
        #expect(recorded.map(\.0) == [
            SpotlightQuery(words: ["tax", "return"], kind: .pdf, changedAfter: after, changedBefore: before),
            SpotlightQuery(words: ["tax"], kind: .any, changedAfter: nil, changedBefore: nil),
        ])
        #expect(recorded.map(\.1) == [11, 3])
        let items = try replies().map { ($0["result"] as? [String: Any])?["items"] as? [[String: Any]] }
        #expect(items.map { $0?.first?["path"] as? String } == [item.path, item.path])
        withExtendedLifetime(service) {}
    }

    /// A search without words, with a kind the helper doesn't know, or with no positive limit is
    /// refused, and nothing is searched.
    @Test(arguments: [
        #"{"kind":"pdf","limit":11}"#,
        #"{"words":["tax"],"kind":"archive","limit":11}"#,
        #"{"words":["tax"],"kind":"pdf","limit":0}"#,
        #"{"words":["tax"],"kind":"pdf"}"#,
    ])
    func aSearchItCantRunSearchesNothing(params: String) async throws {
        let (channel, searches, replies, service) = service(finder: FakeFileOpener())

        await channel.handle(line: Data(#"{"id":1,"method":"filesSearch","params":\#(params)}"#.utf8))

        #expect(try replies().map { $0["error"] != nil } == [true])
        #expect(searches.withLock { $0 }.isEmpty)
        withExtendedLifetime(service) {}
    }

    /// An open with a relative path, or without `reveal`, is refused, and nothing is opened or shown,
    /// though each names an item that is there (`.` is the helper's own folder).
    @Test(arguments: [#"{"path":".","reveal":false}"#, #"{"path":"~/Documents/Report.pdf","reveal":false}"#, #"{"path":"DOCUMENT"}"#])
    func anOpenItCantRunOpensNothing(params: String) async throws {
        try makeItems()
        defer { try? FileManager.default.removeItem(at: root) }
        let finder = FakeFileOpener()
        let (channel, _, replies, service) = service(finder: finder)
        let document = String(data: try JSONEncoder().encode(root.appendingPathComponent("Report.pdf").path), encoding: .utf8) ?? ""

        await channel.handle(line: Data(#"{"id":1,"method":"fileOpen","params":\#(params.replacingOccurrences(of: #""DOCUMENT""#, with: document))}"#.utf8))

        #expect(try replies().map { $0["error"] != nil } == [true])
        #expect(finder.opened.isEmpty && finder.revealed.isEmpty)
        withExtendedLifetime(service) {}
    }
}
