// This Source Code Form is subject to the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/screen.h"
#include <iostream>
#include <map>

// Model a provider whose tree appears only after an extended-property query,
// and a client cache that predates that tree. Exercise the real native adapters.
static voice::Node window, document;
static bool exposed = false, cached = true, failActivation = false;
static bool documentAvailable = true, failDocument = false, missingAttributes = false;
static unsigned releasedAttributes = 0;
static std::map<std::string, std::string> pageAttributes;
static void check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
static void releaseValue(gpointer value) { ++releasedAttributes; g_free(value); }
extern "C" void __wrap_atspi_accessible_clear_cache(AtspiAccessible* node) {
    check(node == window.get(), "refresh stays within the requested window");
    cached = false;
}
extern "C" GHashTable* __wrap_atspi_accessible_get_attributes(AtspiAccessible* node, GError** error) {
    check(node == window.get(), "activation queries the foreground window");
    auto result = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, releaseValue);
    g_hash_table_insert(result, g_strdup("toolkit"), g_strdup("synthetic"));
    if (failActivation) g_set_error_literal(error, g_quark_from_static_string("fixture"), 1, "unavailable");
    else exposed = true;
    return result;
}
extern "C" gint __wrap_atspi_accessible_get_child_count(AtspiAccessible* node, GError**) {
    return node == window.get() && exposed && !cached ? 1 : 0;
}
extern "C" AtspiAccessible* __wrap_atspi_accessible_get_child_at_index(AtspiAccessible*, gint index, GError**) {
    check(index == 0, "only synthetic document requested");
    return reinterpret_cast<AtspiAccessible*>(g_object_ref(document.get()));
}
extern "C" AtspiRole __wrap_atspi_accessible_get_role(AtspiAccessible* node, GError**) {
    return node == document.get() ? ATSPI_ROLE_DOCUMENT_WEB : ATSPI_ROLE_FRAME;
}
extern "C" AtspiDocument* __wrap_atspi_accessible_get_document_iface(AtspiAccessible* node) {
    return documentAvailable ? reinterpret_cast<AtspiDocument*>(g_object_ref(node)) : nullptr;
}
extern "C" GHashTable* __wrap_atspi_document_get_document_attributes(AtspiDocument*, GError** error) {
    if (failDocument) g_set_error_literal(error, g_quark_from_static_string("fixture"), 2, "unavailable");
    if (missingAttributes) return nullptr;
    auto result = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, releaseValue);
    for (const auto& [key, value] : pageAttributes)
        g_hash_table_insert(result, g_strdup(key.c_str()), g_strdup(value.c_str()));
    return result;
}
int main() {
    window = voice::own(reinterpret_cast<AtspiAccessible*>(g_object_new(G_TYPE_OBJECT, nullptr)));
    document = voice::own(reinterpret_cast<AtspiAccessible*>(g_object_new(G_TYPE_OBJECT, nullptr)));
    check(voice::children(window, 10).empty(), "browser initially exposes no page");
    failActivation = true;
    bool failed = false;
    try { voice::requestAccessibility(window); } catch (const std::runtime_error&) { failed = true; }
    check(failed && !exposed && releasedAttributes == 1, "failed activation is retryable and releases metadata");
    failActivation = false;
    voice::requestAccessibility(window);
    check(voice::children(window, 10).size() == 1 && releasedAttributes == 2,
        "activation and cache refresh expose the page without browser configuration");
    // A subsequent read must discard stale descendants even without a new visit.
    cached = true;
    voice::LiveScreenTree tree(window);
    check(tree.children(window, 10).size() == 1, "each capture refreshes delayed provider content");
    const voice::ScreenExclusions policy(nlohmann::json{{"excludedAppIDs", nlohmann::json::array()}, {"excludedHosts", {"secret.example"}}});
    for (const char* key : {"DocURL", "URI"}) {
        pageAttributes = {{key, "https://secret.example/page"}};
        auto page = tree.page(document);
        check(page && policy.excludes(*page), "Firefox and Chromium excluded hosts are both refused");
        pageAttributes = {{key, "https://allowed.example/page"}};
        page = tree.page(document);
        check(page && page->kind == voice::PageHost::Kind::host && page->name == "allowed.example" && !policy.excludes(*page),
            "both browser URL attributes preserve permitted pages");
    }
    check(!tree.page(window), "non-document nodes have no page metadata");
    pageAttributes.clear();
    check(!policy.excludes(*tree.page(document)), "answered empty attributes establish no host");
    pageAttributes = {{"URI", "https://allowed.example"}};
    failDocument = true;
    check(policy.excludes(*tree.page(document)), "failed metadata remains unknown despite partial response");
    failDocument = false; missingAttributes = true;
    check(policy.excludes(*tree.page(document)), "missing metadata fails closed");
    missingAttributes = false; documentAvailable = false;
    check(policy.excludes(*tree.page(document)), "missing document interface fails closed");
    check(releasedAttributes == 7, "all activation and page metadata allocations are released");
    check(G_OBJECT(window.get())->ref_count == 1 && G_OBJECT(document.get())->ref_count == 1,
        "native adapter references return to their original lifetimes");
    std::cout << "browser activation, cache refresh and URL privacy adapters passed\n";
}
