// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#include "Privacy/ScreenAccess.h"
#include <algorithm>
#include <sstream>
#include <fstream>
#include "Privacy/PageScan.h"

using JSON = nlohmann::json;
static void expect(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}
static int run(int argc, char** argv) {
    unsigned lookups = 0, reads = 0;
    std::wstring app = L"Notes.exe";
    const auto identity = [&](int target) {
        expect(target == 42, "identity sees the captured target");
        ++lookups;
        return app;
    };
    const auto read = [&](int target, const voice::ScreenExclusions&) -> JSON {
        expect(target == 42, "read sees the same target");
        ++reads;
        return {{"synthetic", true}};
    };
    const JSON allowed{{"excludedAppIDs", JSON::array()}, {"excludedHosts", JSON::array()}};
    const JSON excluded{{"excludedAppIDs", {"notes.EXE"}}, {"excludedHosts", JSON::array()}};
    std::ostringstream log;
    auto* original = std::cerr.rdbuf(log.rdbuf());
    try {
        expect(voice::screenAccess(excluded, 42, identity, read) == JSON{{"hidden", true}}, "excluded screen refused, and reported as hidden with nothing of it");
        expect(voice::screenAccess(excluded, 42, identity, read, true) == JSON{{"value", nullptr}}, "excluded field refused");
        expect(lookups == 2 && reads == 0, "exclusion never invokes accessibility or title read");
        expect(log.str() == "debug screen access: excluded app not read\ndebug screen access: excluded app not read\n", "logs contain only categories");
        expect(voice::screenAccess(allowed, 0, identity, read).is_null(), "no foreground target refused");
        expect(voice::screenAccess(allowed, 0, identity, read, true).is_null(), "no correction target refused");
        expect(lookups == 2 && reads == 0, "no foreground performs no lookup or read");
        for (const auto& policy : {JSON::object(), JSON{{"excludedAppIDs", nullptr}},
             JSON{{"excludedAppIDs", "Notes.exe"}}, JSON{{"excludedAppIDs", {"Notes.exe", 1}}},
             JSON{{"excludedAppIDs", JSON::array()}, {"excludedHosts", nullptr}},
             JSON{{"excludedAppIDs", JSON::array()}, {"excludedHosts", "example.com"}},
             JSON{{"excludedAppIDs", JSON::array()}, {"excludedHosts", {"example.com", 1}}}}) {
            for (const bool field : {false, true}) {
                bool threw = false;
                try { voice::screenAccess(policy, 42, identity, read, field); }
                catch (const std::runtime_error&) { threw = true; }
                expect(threw, "malformed policy is an error");
            }
        }
        expect(lookups == 2 && reads == 0, "malformed policy reads nothing, even identity");
        for (const auto& name : {L"Other.exe", L"Notes.exe.extra", L""}) {
            app = name;
            expect(voice::screenAccess(excluded, 42, identity, read) == JSON{{"synthetic", true}}, "other, prefix and missing identity allowed");
        }
        expect(lookups == 5 && reads == 3, "one identity lookup per read");
        app = L"Notes.exe";
        expect(voice::screenAccess(allowed, 42, identity, read, true) == JSON{{"synthetic", true}}, "allowed correction field read");
        expect(lookups == 6 && reads == 4, "each allowed field read uses checked target");
        expect(voice::ScreenExclusions(JSON{{"excludedAppIDs", {""}}, {"excludedHosts", JSON::array()}}).excludesApp(L""), "empty strings remain valid policy entries");
    } catch (...) { std::cerr.rdbuf(original); throw; }
    std::cerr.rdbuf(original);
    const voice::ScreenExclusions unicodePolicy(JSON{{"excludedAppIDs", {"Straße", "é"}}, {"excludedHosts", {"Straße.example"}}});
    expect(unicodePolicy.excludesApp(L"STRASSE"), "full Unicode folding");
    expect(unicodePolicy.excludesApp(L"e\u0301"), "canonical equivalence");
    expect(unicodePolicy.excludesHost(L"sub.STRASSE.example."), "Unicode host suffix");
    expect(argc == 3, "host and address conformance files provided");
    std::ifstream addressFile(argv[2]); const auto addresses = JSON::parse(addressFile);
    for (const auto& item : addresses.at("cases")) {
        voice::PageHost page;
        if (!item["address"].is_null()) {
            const auto text = item["address"].get<std::string>();
            // Preserve embedded NUL for the adapter's refusal test; paste conversion rejects it earlier.
            const int size = static_cast<int>(text.size());
            const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), size, nullptr, 0);
            std::wstring address(static_cast<size_t>(count), L'\0');
            if (count) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), size, address.data(), count);
            page = voice::hostOfAddress(address);
        }
        const std::string kind = page.kind == voice::PageHost::Kind::host ? "host" : page.kind == voice::PageHost::Kind::noHost ? "noHost" : "unknown";
        expect(kind == item["kind"].get<std::string>() && voice::utf8(page.name) == item["host"].get<std::string>(), "shared address conformance");
    }
    std::ifstream input(argv[1]);
    const auto cases = JSON::parse(input);
    for (const auto& item : cases["cases"]) {
        voice::ScreenExclusions policy(JSON{{"excludedAppIDs", JSON::array()}, {"excludedHosts", {item["site"]}}});
        const auto host = item["host"].get<std::string>();
        expect(policy.excludesHost(host.empty() ? L"" : voice::utf16(host)) == item["excluded"].get<bool>(), "shared host conformance");
    }
    voice::ScreenExclusions policy(JSON{{"excludedAppIDs", JSON::array()}, {"excludedHosts", {"example.com"}}});
    expect(policy.excludes(voice::PageHost{}), "unknown page refused");
    expect(!policy.excludes({voice::PageHost::Kind::noHost, {}}), "explicitly absent address allowed");
    expect(policy.excludes(voice::hostOfAddress(L"https://user:synthetic@mail.example.com:443/path?q=synthetic#fragment")), "URL parser extracts only host");
    expect(voice::hostOfAddress(L"chrome-extension://synthetic-id/page").name == L"chrome-extension", "non-web address contributes scheme");
    expect(voice::hostOfAddress(L"file:///C:/synthetic.html").name == L"file", "local page uses file scheme");
    struct FakeNode { bool password; std::optional<voice::PageHost> page; std::vector<int> children; };
    struct Tree {
        using Node = int;
        std::vector<FakeNode> nodes;
        unsigned childReads = 0;
        // Budget checks left before the time budget runs out.
        unsigned budget = ~0u;
        bool withinBudget() { return budget && budget--; }
        bool isPassword(Node n) { return nodes.at(n).password; }
        auto page(Node n) { expect(!nodes.at(n).password, "protected page property never requested"); return nodes.at(n).page; }
        std::vector<Node> children(Node n, size_t limit) {
            expect(!nodes.at(n).password, "protected children never requested");
            ++childReads;
            const auto& all = nodes.at(n).children;
            return {all.begin(), all.begin() + static_cast<std::ptrdiff_t>(std::min(limit, all.size()))};
        }
    };
    using voice::privacy::PageLook;
    const voice::PageHost refused{voice::PageHost::Kind::host, L"mail.example.com"};
    const voice::PageHost safe{voice::PageHost::Kind::host, L"other.example"};
    for (const auto page : {refused, voice::PageHost{}}) {
        Tree tree{{{false, {}, {1}}, {false, page, {2}}, {false, {}, {}}}};
        expect(voice::privacy::lookForExcludedPage(tree, 0, policy, true) == PageLook::excluded, "nested excluded and unknown pages refuse");
        expect(tree.childReads == 1, "refused page's descendants not queried");
    }
    Tree protectedTree{{{false, {}, {1}}, {true, refused, {2}}, {false, {}, {}}}};
    expect(voice::privacy::lookForExcludedPage(protectedTree, 0, policy, true) == PageLook::none, "password subtree never read");
    expect(protectedTree.childReads == 1, "password subtree not entered");
    expect(!voice::privacy::safeTextSubtree(protectedTree, 0), "aggregate text containing a protected descendant is not read");
    Tree plainTree{{{false, {}, {1}}, {false, {}, {}}}};
    expect(voice::privacy::safeTextSubtree(plainTree, 0), "ordinary aggregate text remains readable");
    Tree frame{{{false, safe, {1}}, {false, refused, {}}}};
    expect(voice::privacy::lookForExcludedPage(frame, 0, policy, true) == PageLook::excluded, "nested frame refused");
    frame.childReads = 0;
    expect(voice::privacy::lookForExcludedPage(frame, 0, policy, false) == PageLook::none && frame.childReads == 0, "bounded correction window scan stops at safe page");
    // A look that runs out of either budget before the end has not seen the element whole,
    // even where nothing excluded is in what it reached (ADR-DESK-054).
    Tree timed{{{false, {}, {1}}, {false, {}, {2}}, {false, {}, {}}}};
    timed.budget = 2;
    expect(voice::privacy::lookForExcludedPage(timed, 0, policy, true) == PageLook::notSeenWhole, "out of time is not seen whole");
    timed.budget = 3;
    expect(voice::privacy::lookForExcludedPage(timed, 0, policy, true) == PageLook::notSeenWhole, "out of time after the last listing is not seen whole");
    timed.budget = ~0u;
    expect(voice::privacy::lookForExcludedPage(timed, 0, policy, true) == PageLook::none, "seen whole within budget");
    for (const int width : {4998, 4999}) {
        Tree wide{{{false, {}, {}}}};
        for (int child = 1; child <= width; ++child) { wide.nodes[0].children.push_back(child); wide.nodes.push_back({false, {}, {}}); }
        const auto look = voice::privacy::lookForExcludedPage(wide, 0, policy, true);
        expect(width == 4998 ? look == PageLook::none : look == PageLook::notSeenWhole, "the node budget decides whether it was seen whole");
    }
    // A list wider than the node budget is listed only in part, and an excluded page in that part is
    // still found: the go-on callers (the focus and correction-window looks) refuse on it.
    Tree wideList{{{false, {}, {1}}, {false, {}, {}}}};
    for (int item = 2; item < 6002; ++item) {
        wideList.nodes[1].children.push_back(item);
        wideList.nodes.push_back({false, item == 12 ? std::optional{refused} : std::nullopt, {}});
    }
    expect(voice::privacy::lookForExcludedPage(wideList, 0, policy, true) == PageLook::excluded, "an excluded page in a list wider than the budget is found");
    std::cout << "Screen handlers refuse excluded and malformed requests before any read\n";
    return 0;
}
int main(int argc, char** argv) {
    try { return run(argc, argv); }
    catch (const std::exception& error) {
        std::cerr << "Screen access assertion: " << error.what() << '\n';
        return 1;
    }
}
