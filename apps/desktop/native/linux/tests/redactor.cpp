// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../../shared/privacy/ScreenPrivacy.h"
#include <nlohmann/json.hpp>
#include <unicode/ustring.h>
#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>
using namespace voice::privacy;
using JSON = nlohmann::json;
static void expect(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
static std::u16string decode(const std::string& value) {
    UErrorCode status = U_ZERO_ERROR;
    int32_t length = 0;
    u_strFromUTF8(nullptr, 0, &length, value.data(), static_cast<int32_t>(value.size()), &status);
    expect(status == U_BUFFER_OVERFLOW_ERROR || U_SUCCESS(status), "invalid UTF-8 fixture");
    status = U_ZERO_ERROR;
    std::u16string result(static_cast<size_t>(length), u'\0');
    u_strFromUTF8(result.data(), length, nullptr, value.data(), static_cast<int32_t>(value.size()), &status);
    expect(U_SUCCESS(status), "UTF-8 fixture conversion failed");
    return result;
}
static std::u16string joined(const JSON& pieces) {
    std::u16string result;
    for (const auto& piece : pieces) {
        const auto value = piece.get<std::string>();
        result += value == "{redacted}" ? std::u16string(placeholder) : decode(value);
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
            expect(result == joined(item.at("expected")), item.at("name").get<std::string>().c_str());
            expect(Redactor::redact(result) == result, "single text idempotence");
        }
        for (const auto& item : suite.at("lineCases")) {
            const auto result = Redactor::redact(lines(item.at("lines")));
            expect(result == lines(item.at("expected")), item.at("name").get<std::string>().c_str());
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
        expect(ScreenPrivacy::apply(absent, caret) && caret[1] == "[redacted]", "unwalked caret is filtered");
        const std::string unicode = "Grüße 🙂 漢字";
        expect(ScreenPrivacy::encode(ScreenPrivacy::decode(unicode)) == unicode, "shared UTF conversion round trip");
        bool invalidRefused = false;
        try { ScreenPrivacy::decode(std::string(1, static_cast<char>(0xff))); }
        catch (...) { invalidRefused = true; }
        expect(invalidRefused, "malformed provider UTF-8 refused");
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
        // Exercise a real Rust stack refusal through the linked C ABI.
        const auto failed = Redactor::redact(Lines{{u"token=" u"abc123def "}, {std::u16string(u"password:") + std::u16string(1000100, u' ') + u"x private remainder"}});
        expect(failed == Lines{{std::u16string(u"token=") + std::u16string(placeholder) + std::u16string(placeholder)}, {u""}}, "unfinished match withholds remainder after last completed match");
        std::cout << "shared redactor corpus, boundaries, idempotence, mutations and hostile-input checks passed\n";
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
