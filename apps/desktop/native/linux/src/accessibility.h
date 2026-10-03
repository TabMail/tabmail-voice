// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <atspi/atspi.h>
#include <gio/gio.h>
#include <memory>
#include <stdexcept>
#include <vector>
#include <chrono>

namespace voice {
template<class T> struct Unref { void operator()(T* value) const { if (value) g_object_unref(value); } };
template<class T> using Object = std::shared_ptr<T>;
template<class T> Object<T> own(T* value) { return Object<T>(value, Unref<T>{}); }
struct Error {
    GError* value = nullptr;
    ~Error() { if (value) g_error_free(value); }
    void check() const { if (value) throw std::runtime_error("accessibility provider failed"); }
};
using Node = Object<AtspiAccessible>;
// AT-SPI client initialization connects to the bus but does not ask applications
// to expose their trees. Firefox and other toolkits watch this standard switch.
// Never turn it off on exit: other assistive clients may still be using it.
inline bool enableAccessibilityBridge() {
    Error error;
    auto bus = own(g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error.value));
    if (!bus) return false;
    auto reply = g_dbus_connection_call_sync(bus.get(), "org.a11y.Bus", "/org/a11y/bus",
        "org.freedesktop.DBus.Properties", "Set",
        g_variant_new("(ssv)", "org.a11y.Status", "IsEnabled", g_variant_new_boolean(true)),
        G_VARIANT_TYPE_UNIT, G_DBUS_CALL_FLAGS_NONE, 1000, nullptr, &error.value);
    if (!reply) return false;
    g_variant_unref(reply);
    return true;
}
// Chromium treats extended-property queries as an assistive-client activation
// signal. Ask on each bounded foreground visit, before dictation starts.
// https://github.com/chromium/chromium/blob/main/ui/accessibility/platform/ax_platform_node_auralinux.cc
inline void requestAccessibility(const Node& root) {
    atspi_accessible_clear_cache(root.get());
    Error error;
    auto attributes = atspi_accessible_get_attributes(root.get(), &error.value);
    if (attributes) g_hash_table_unref(attributes);
    error.check();
}
inline AtspiRole role(const Node& node) {
    Error error;
    const auto result = atspi_accessible_get_role(node.get(), &error.value);
    error.check();
    return result;
}
inline bool state(const Node& node, AtspiStateType state) {
    auto states = own(atspi_accessible_get_state_set(node.get()));
    if (!states) throw std::runtime_error("accessibility states unavailable");
    return atspi_state_set_contains(states.get(), state);
}
inline std::vector<Node> children(const Node& node, size_t limit) {
    Error error;
    const auto count = atspi_accessible_get_child_count(node.get(), &error.value);
    error.check();
    if (count < 0 || static_cast<size_t>(count) > limit) throw std::runtime_error("accessibility child budget");
    std::vector<Node> result;
    for (int i = 0; i < count; ++i) {
        auto child = own(atspi_accessible_get_child_at_index(node.get(), i, &error.value));
        error.check();
        if (!child) throw std::runtime_error("accessibility child unavailable");
        result.push_back(std::move(child));
    }
    return result;
}
inline Node parent(const Node& node) {
    Error error;
    auto result = own(atspi_accessible_get_parent(node.get(), &error.value));
    error.check();
    return result;
}
inline bool same(const Node& first, const Node& second) { return first.get() == second.get(); }
inline std::vector<Node> ancestors(const Node& focus) {
    std::vector<Node> path;
    for (auto node = parent(focus); node; node = parent(node)) {
        if (path.size() >= 200) throw std::runtime_error("focus depth budget");
        if (role(node) == ATSPI_ROLE_APPLICATION) break;
        for (const auto& seen : path) if (same(seen, node)) throw std::runtime_error("cyclic focus path");
        path.push_back(node);
    }
    return path;
}
inline bool password(const Node& node) { return role(node) == ATSPI_ROLE_PASSWORD_TEXT; }
}
