// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/privacy.h"
#include <iostream>
#include <fstream>
using JSON = nlohmann::json;
static void expect(bool value) { if (!value) throw std::runtime_error("privacy contract failed"); }
int main(int argc, char** argv) {
    expect(argc == 3);
    std::ifstream file(argv[1]); JSON corpus; file >> corpus;
    std::ifstream addressFile(argv[2]); JSON addresses; addressFile >> addresses;
    for (const auto& item : addresses.at("cases")) {
        const auto page = voice::hostOfAddress(item["address"].is_null() ? std::nullopt : std::optional(item["address"].get<std::string>()));
        const std::string kind = page.kind == voice::PageHost::Kind::host ? "host" : page.kind == voice::PageHost::Kind::noHost ? "noHost" : "unknown";
        expect(kind == item["kind"].get<std::string>() && page.name == item["host"].get<std::string>());
    }
    unsigned positive = 0, negative = 0;
    for (const auto& item : corpus.at("cases")) {
        const voice::ScreenExclusions exclusions({{"excludedAppIDs", JSON::array()}, {"excludedHosts", JSON::array({item.at("site")})}});
        const bool expected = item.at("excluded");
        expected ? ++positive : ++negative;
        expect(exclusions.excludesHost(item.at("host")) == expected);
    }
    expect(positive > 0 && negative > 0 && positive + negative == corpus.at("cases").size());
    const voice::ScreenExclusions unicodePolicy(JSON{{"excludedAppIDs", {"Straße", "é"}}, {"excludedHosts", {"Straße.example"}}});
    expect(unicodePolicy.excludesApp("STRASSE"));
    expect(unicodePolicy.excludesApp("e\u0301"));
    expect(unicodePolicy.excludesHost("sub.STRASSE.example."));
    const JSON valid{{"excludedAppIDs", {"ORG.GNOME.TextEditor.desktop"}}, {"excludedHosts", {"secret.example", "vault"}}};
    unsigned identityCalls = 0, readCalls = 0;
    const auto identify = [&](int) -> std::optional<std::string> { ++identityCalls; return "org.gnome.texteditor.desktop"; };
    const auto read = [&](int, const voice::ScreenExclusions&) { ++readCalls; return JSON{{"synthetic", true}}; };
    expect(voice::screenAccess(valid, 1, identify, read) == voice::hiddenScreen());
    expect(identityCalls == 1 && readCalls == 0);
    for (const char* key : {"excludedAppIDs", "excludedHosts"}) {
        for (const JSON& replacement : {JSON(nullptr), JSON("invalid"), JSON{false}, JSON::array({1})}) {
            auto bad = valid; bad[key] = replacement;
            bool refused = false;
            try { voice::screenAccess(bad, 1, identify, read); } catch (...) { refused = true; }
            expect(refused && identityCalls == 1 && readCalls == 0);
        }
        auto bad = valid; bad.erase(key);
        bool refused = false;
        try { voice::screenAccess(bad, 1, identify, read); } catch (...) { refused = true; }
        expect(refused && identityCalls == 1 && readCalls == 0);

    }
    const voice::ScreenExclusions policy(valid);
    expect(policy.excludes(voice::hostOfAddress("https://child.SECRET.example./page")));
    expect(policy.excludes(voice::hostOfAddress("vault://item/synthetic")));
    expect(!policy.excludes(voice::hostOfAddress("https://secret.example.evil.test/")));
    expect(!policy.excludes(voice::hostOfAddress("https://other.example/")));
    expect(!policy.excludes(voice::hostOfAddress(std::string{})));
    expect(policy.excludes(voice::hostOfAddress(std::nullopt)));
    expect(policy.excludes(voice::hostOfAddress("https://")));
    const auto unknown = [](int) -> std::optional<std::string> { return std::nullopt; };
    expect(voice::screenAccess(valid, 1, unknown, read)["synthetic"] == true && readCalls == 1);
    auto large = valid; large["excludedAppIDs"] = std::vector<std::string>(1001, "allowed");
    large["excludedAppIDs"][1000] = "org.gnome.texteditor.desktop";
    expect((voice::screenAccess(large, 1, identify, read) == voice::hiddenScreen()) && readCalls == 1);
    auto allowed = valid; allowed["excludedAppIDs"] = JSON::array();
    expect(voice::screenAccess(allowed, 1, identify, read)["synthetic"] == true && readCalls == 2);
    std::cout << "screen policy validation, identity-before-access census and URI refusal passed\n";
}
