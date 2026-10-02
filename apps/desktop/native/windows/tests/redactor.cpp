// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "Privacy/ScreenPrivacy.h"
#include "text.h"
#include <nlohmann/json.hpp>
#include <chrono>
#include <fstream>
#include <sstream>
using namespace voice::privacy;
using JSON = nlohmann::json;
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
        std::array<std::string, 3> caret{"synthetic", "value", "123"};
        expect(ScreenPrivacy::apply(context, caret), "split secret changes the selection");
        expect(caret[1] == "[redacted]", "empty redacted selection remains a selection");
        expect(context.render() == "password:\n» [redacted]‸[redacted]‸", "blocks and caret redact together before rendering");
        voice::VisibleContext absent;
        absent.append(voice::ContextKind::text, "password:");
        caret = {"synthetic", "value", "123"};
        expect(ScreenPrivacy::apply(absent, caret) && caret[1] == "[redacted]", "caret text is still filtered when no caret block was walked");
        // Every generated definition is load-bearing on the shared conformance corpus.
        for (size_t omitted = 0; omitted < std::size(definitions); ++omitted) {
            std::vector<Definition> remaining;
            for (size_t i = 0; i < std::size(definitions); ++i) if (i != omitted) remaining.push_back(definitions[i]);
            bool failed = false;
            for (const auto& item : suite.at("cases")) {
                if (Redactor::redact(Lines{{joined(item.at("text"))}}, remaining)[0][0] != joined(item.at("expected"))) { failed = true; break; }
            }
            expect(failed, std::string("mutation not detected: ") + definitions[omitted].name);
        }
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
        // Real ICU stack exhaustion after a successful match must withhold the remainder.
        const Definition failing[] = {{"synthetic-failure", u"secret|(a+)+$", false, u"[redacted]"}};
        std::ostringstream captured;
        const auto original = std::cerr.rdbuf(captured.rdbuf());
        Lines failed;
        try { failed = Redactor::redact(Lines{{u"secret "}, {std::u16string(20000, u'a') + u"! private remainder"}}, failing, 1024); }
        catch (...) { std::cerr.rdbuf(original); throw; }
        std::cerr.rdbuf(original);
        expect(failed == Lines{{std::u16string(placeholder) + std::u16string(placeholder)}, {u""}}, "unfinished match withholds remainder after last completed match");
        expect(captured.str() == "debug redactor unfinished: synthetic-failure\n", "failure logs only rule name");
        std::cout << suite.at("cases").size() << " single cases, " << suite.at("lineCases").size()
            << " line cases, idempotence, rule removal mutations, long and hostile runs, and failure closure passed\n";
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
