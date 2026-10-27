// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/page_selection.h"
#include "../../shared/context/screen_context.h"
#include <iostream>

using namespace voice;
struct Element {
    bool password = false;
    std::optional<bool> excludedPage;
    std::vector<Element*> children;
};
struct Tree {
    using Node = Element*;
    bool budget = true, expire = false, unavailable = false;
    bool withinBudget() const { return budget; }
    bool isPassword(Node node) {
        if (unavailable) throw std::runtime_error("metadata unavailable");
        return node->password;
    }
    std::optional<bool> page(Node node) { return node->excludedPage; }
    std::vector<Node> children(Node node, size_t limit) {
        if (expire) budget = false;
        if (node->children.size() > limit) throw std::runtime_error("incomplete census");
        return node->children;
    }
};
struct Exclusions { bool excludes(bool excluded) const { return excluded; } };
static void expect(bool ok, const char* name) { if (!ok) throw std::runtime_error(name); }
int main() {
    try {
        Element selected{}, neighbor{}, document{false, {}, {&selected, &neighbor}};
        unsigned textReads = 0;
        const auto read = [&] { ++textReads; return CaretSource{{"Draft. token=", "syntheticPrivate123", ". More."}}; };
        Tree tree;
        const auto source = pageSelectionSource(tree, &document, Exclusions{}, read);
        expect(textReads == 1 && !source.selectionUnavailable, "approved document permits one bounded source read");
        VisibleContext context(source.parts, true);
        context.append(ContextKind::caret, "");
        const auto reply = context.reply({{"appName", "Synthetic page"}}, source.parts, false,
            {{"excludedAppIDs", nlohmann::json::array()}, {"excludedHosts", nlohmann::json::array()}}, 0);
        expect(reply.at("selectedText") == "[redacted]" && reply.at("selectionRedacted") == true,
            "native transport preserves private context through the production finalizer");
        expect(reply.at("textBeforeCaret") == "" && reply.at("textAfterCaret") == "" &&
            reply.dump().find("syntheticPrivate123") == std::string::npos, "no private source escapes any reply field");
        // Private recognition neighbors must not displace visible text at the native budget edge.
        const std::array<std::string, 3> largeSource{
            "private prefix. " + std::string(6000, 'a'), "chosen", std::string(6000, 'b') + ". private suffix"};
        VisibleContext boundary(largeSource, true);
        boundary.append(ContextKind::text, std::string(VisibleContext::sourceLimit() - 100, 'z'));
        expect(!boundary.textBudgetFull, "private source does not consume presentation reservation");
        boundary.append(ContextKind::text, "visible-tail-marker");
        const auto boundaryReply = boundary.reply({{"appName", "Synthetic page"}}, largeSource, false,
            {{"excludedAppIDs", nlohmann::json::array()}, {"excludedHosts", nlohmann::json::array()}}, 0);
        expect(boundary.count() == 2 && boundaryReply.at("selectedText") == "chosen" &&
            boundaryReply.at("renderedText").get<std::string>().find("visible-tail-marker") != std::string::npos,
            "selection and late visible text survive native budget admission");
        expect(boundaryReply.at("textBeforeCaret") == "" && boundaryReply.at("textAfterCaret") == "" &&
            boundaryReply.dump().find("private prefix") == std::string::npos &&
            boundaryReply.dump().find("private suffix") == std::string::npos, "recognition neighbors remain private");
        for (const auto refusal : {"password", "excluded", "expired", "missing"}) {
            neighbor = {}; tree = {}; textReads = 0;
            const std::string mode(refusal);
            neighbor.password = mode == "password";
            if (mode == "excluded") neighbor.excludedPage = true;
            tree.expire = mode == "expired";
            tree.unavailable = mode == "missing";
            bool refused = false;
            try {
                const auto value = pageSelectionSource(tree, &document, Exclusions{}, read);
                refused = value.selectionUnavailable && value.parts == std::array<std::string, 3>{};
            } catch (const std::exception&) { refused = true; }
            expect(refused && textReads == 0, "unapproved neighbor or incomplete metadata prevents every source-text read");
        }
        std::cout << "page selection source admission and projection contracts passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
