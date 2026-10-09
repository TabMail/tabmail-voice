// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "Privacy/ScreenPrivacy.h"
#include "screen_context.h"
#include "text.h"
#include <nlohmann/json.hpp>
#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>
using namespace voice::privacy;
using JSON = nlohmann::json;
// The core's redaction marker (`limits`), which the helpers never spell themselves.
static const std::u16string placeholder = decodeUtf8(voice::core::request({{"limits", true}}, voice_core_context_json).at("redactedMarker").get<std::string>());
static void expect(bool value, const std::string& name) { if (!value) throw std::runtime_error(name); }
static std::u16string joined(const JSON& pieces) {
    std::u16string result;
    for (const auto& piece : pieces) {
        const auto value = piece.get<std::string>();
        if (value == "{redacted}") result += placeholder;
        else if (!value.empty()) { const auto wide = voice::utf16(value); result.append(wide.begin(), wide.end()); }
    }
    return result;
}
static Lines lines(const JSON& value) {
    Lines result;
    for (const auto& line : value) {
        std::vector<std::u16string> parts;
        for (const auto& part : line) parts.push_back(joined(part));
        result.push_back(std::move(parts));
    }
    return result;
}
int main(int argc, char** argv) {
    try {
        expect(argc == 2, "supply shared conformance path");
        std::ifstream stream(argv[1]); JSON suite; stream >> suite;
        for (const auto& item : suite.at("cases")) {
            const auto result = Redactor::redact(joined(item.at("text")));
            expect(result == joined(item.at("expected")), item.at("name"));
            expect(Redactor::redact(result) == result, "single text idempotence");
        }
        for (const auto& item : suite.at("lineCases")) {
            const auto result = Redactor::redact(lines(item.at("lines")));
            expect(result == lines(item.at("expected")), item.at("name"));
            expect(Redactor::redact(result) == result, "several texts idempotence");
        }
        voice::VisibleContext context;
        context.append(voice::ContextKind::text, "password:");
        context.append(voice::ContextKind::caret, "ignored markers", voice::ContextFrame{1, 2, 3, 4});
        const JSON none{{"excludedAppIDs", JSON::array()}, {"excludedHosts", JSON::array()}};
        auto reply = context.reply({{"appName", "Synthetic"}}, {"synthetic", "value", "123"}, false, none, 0);
        expect(reply.at("selectionRedacted") == true, "split secret changes the selection");
        expect(reply.at("selectedText") == "[redacted]", "empty redacted selection remains a selection");
        expect(reply.at("renderedText") == "password:\n» [redacted]‸[redacted]‸", "blocks and caret redact together before rendering");
        voice::VisibleContext absent;
        absent.append(voice::ContextKind::text, "password:");
        reply = absent.reply({{"appName", "Synthetic"}}, {"synthetic", "value", "123"}, false, none, 0);
        expect(reply.at("selectionRedacted") == true && reply.at("selectedText") == "[redacted]", "caret text is still filtered when no caret block was walked");
        // A selection the helper could not read whole is sent as the placeholder, which redaction leaves
        // as it is: only the flag says it is not the user's text, so Edit never pastes over it.
        voice::VisibleContext unreadable;
        unreadable.append(voice::ContextKind::text, "plain words");
        reply = unreadable.reply({{"appName", "Synthetic"}}, {"before ", "[redacted]", " after"}, true, none, 0);
        expect(reply.at("selectionRedacted") == true, "a selection not read whole is flagged");
        voice::VisibleContext readable;
        readable.append(voice::ContextKind::text, "plain words");
        reply = readable.reply({{"appName", "Synthetic"}}, {"before ", "chosen", " after"}, false, none, 0);
        expect(reply.at("selectionRedacted") == false && reply.at("selectedText") == "chosen", "a selection read whole is not flagged");
        // Every generated definition is load-bearing on the shared conformance corpus.
        // Definition mutations are tested once by the Rust crate.
        for (const auto start : {u"sk-", u"data token=7", u"Bearer ", u"eyJ", u"eyJa.eyJ", u"eyJa.eyJa.", u"://u:",
            u"-----BEGIN PRIVATE KEY-----\n", u"sk_live_", u"glpat-", u"xoxb-"}) {
            const auto text = std::u16string(start) + std::u16string(400000, u'a') + u"\npassword: hunter" + u"2x\n";
            expect(Redactor::redact(text).ends_with(std::u16string(u": ") + std::u16string(placeholder) + u"\n"), "long run preserves later redaction");
        }
        for (const auto unit : {u"a.", u"token:", u"-eyJ", u"-----BEGIN A ", u"://a:b", u"://a:b@", u"@://a:b", u"Bearer ", u"-sk-a", u"password                                                                ", u"a"}) {
            std::u16string text;
            while (text.size() < 200000) text += unit;
            const auto start = std::chrono::steady_clock::now();
            Redactor::redact(text);
            expect(std::chrono::steady_clock::now() - start < std::chrono::seconds(2), "hostile input time bound");
        }
        std::cout << suite.at("cases").size() << " single cases, " << suite.at("lineCases").size()
            << " line cases, idempotence, redactor removal mutations, and long and hostile runs passed\n";
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
