// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "accessibility.h"
#include "identity.h"
#include <algorithm>
#include <functional>
#include <iostream>
#include <memory>
#include <string_view>

namespace voice {
// Focus/window events start one bounded visit. A successful query stops retries;
// losing focus cancels them. No permanent polling and no activation at key-down.
class Foreground {
public:
    static constexpr unsigned attempts = 5, retryMilliseconds = 1000;
    /** `shellHolds`: whether the Shell holds the keyboard for the dictation key (`GnomeCaret::holding`). */
    explicit Foreground(std::function<bool()> shellHolds) : shellHolds(std::move(shellHolds)) {
        listener = own(atspi_event_listener_new([](AtspiEvent* event, void* data) {
            const auto freeEvent = [](AtspiEvent* value) { g_boxed_free(ATSPI_TYPE_EVENT, value); };
            std::unique_ptr<AtspiEvent, decltype(freeEvent)> owned(event, freeEvent);
            static_cast<Foreground*>(data)->event(event);
        }, this, nullptr));
        Error error;
        for (const char* type : {"object:state-changed:focused", "window:activate", "window:deactivate"}) {
            if (!atspi_event_listener_register(listener.get(), type, &error.value))
                throw std::runtime_error("focus listener unavailable");
            error.check();
        }
        // Bootstrap only once. Afterwards visits are driven entirely by events.
        retry = g_idle_add([](gpointer data) -> gboolean {
            auto self = static_cast<Foreground*>(data); self->retry = 0;
            try { self->bootstrap(); } catch (...) { std::cerr << "debug accessibility: initial focus unavailable\n"; }
            return G_SOURCE_REMOVE;
        }, this);
    }
    ~Foreground() {
        cancelRetry();
        for (const char* type : {"object:state-changed:focused", "window:activate", "window:deactivate"}) {
            Error error;
            atspi_event_listener_deregister(listener.get(), type, &error.value);
        }
    }
    struct Target { uint64_t token; Node focus; std::optional<AppIdentity> app; bool terminal = false; };
    std::optional<Target> target() const { return current; }
    bool matches(uint64_t token) const {
        return current && current->token == token && state(current->focus, ATSPI_STATE_FOCUSED);
    }
    /** `matches`, or the Shell holds the keyboard for the dictation key: the window in front has no
     * keyboard focus meanwhile, yet it is still the target. Not for an insertion: a paste while the
     * Shell holds the keyboard reaches no window. */
    bool targets(uint64_t token) const {
        return matches(token) || (current && current->token == token && shellHolds());
    }
private:
    std::function<bool()> shellHolds;
    Object<AtspiEventListener> listener;
    Node active;
    Node tokenWindow;
    uint64_t windowToken = 0;
    std::optional<Target> current;
    uint64_t next = static_cast<uint64_t>(g_random_int()) * 1024;
    guint retry = 0;
    unsigned tried = 0;
    void cancelRetry() { if (retry) g_source_remove(retry); retry = 0; }
    void remember(const Node& focus) {
        if (current && same(current->focus, focus)) return;
        const auto path = ancestors(focus);
        const auto window = std::find_if(path.begin(), path.end(), [](const Node& node) {
            const auto kind = role(node);
            return kind == ATSPI_ROLE_FRAME || kind == ATSPI_ROLE_DIALOG || kind == ATSPI_ROLE_WINDOW;
        });
        if (window == path.end()) { current.reset(); return; }
        // The dictation target is the original app/window, not the original field
        // or caret. Moving between fields in that window must keep its identity.
        if (!same(tokenWindow, *window)) { tokenWindow = *window; windowToken = ++next; }
        Error error;
        const auto pid = atspi_accessible_get_process_id(focus.get(), &error.value);
        error.check(); // This queries the accessibility bus daemon, not the target application.
        const bool terminal = role(focus) == ATSPI_ROLE_TERMINAL ||
            std::any_of(path.begin(), path.end(), [](const Node& node) { return role(node) == ATSPI_ROLE_TERMINAL; });
        current = Target{windowToken, focus, desktopIdentity(pid), terminal};
    }
    Node findFocus(const Node& root) {
        std::vector<Node> stack{root};
        unsigned visited = 0;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1000);
        while (!stack.empty()) {
            if (++visited > 5000 || std::chrono::steady_clock::now() > deadline)
                throw std::runtime_error("focus lookup budget");
            auto node = std::move(stack.back()); stack.pop_back();
            if (state(node, ATSPI_STATE_FOCUSED)) return node;
            if (password(node)) continue;
            auto nextChildren = children(node, 5000 - visited - stack.size());
            for (auto it = nextChildren.rbegin(); it != nextChildren.rend(); ++it) stack.push_back(*it);
        }
        return {};
    }
    void warm() {
        ++tried;
        try {
            requestAccessibility(active);
            if (auto focus = findFocus(active)) { remember(focus); return; }
            std::cerr << "debug accessibility: foreground has no focused element\n";
        } catch (...) { std::cerr << "debug accessibility: foreground lookup unavailable\n"; }
        if (tried < attempts) retry = g_timeout_add(retryMilliseconds, [](gpointer data) -> gboolean {
            auto self = static_cast<Foreground*>(data); self->retry = 0; self->warm(); return G_SOURCE_REMOVE;
        }, this);
    }
    void event(AtspiEvent* event) {
        if (!event->source) return;
        auto source = own(ATSPI_ACCESSIBLE(g_object_ref(event->source)));
        const std::string type = event->type ? event->type : "";
        try {
            // The focus moves to the Shell and back while it holds the keyboard for the dictation
            // key: the target stays. The Shell's own interface is never a target.
            if (shell(source) || shellHolds()) return;
            if (type == "window:deactivate") {
                if (same(source, active) || same(source, tokenWindow)) { current.reset(); active.reset(); cancelRetry(); }
            }
            else if (type == "window:activate") {
                // An app can announce its focused element before its window (LibreOffice).
                if (current && same(source, tokenWindow) && state(current->focus, ATSPI_STATE_FOCUSED)) {
                    cancelRetry(); active = source; return;
                }
                current.reset(); cancelRetry(); active = source; tried = 0; warm();
            } else if (event->detail1) {
                // A container announced after the element inside it that keeps focus (LibreOffice's
                // root pane, which then loses focus silently) doesn't take its place.
                if (current && state(current->focus, ATSPI_STATE_FOCUSED)) {
                    const auto path = ancestors(current->focus);
                    if (std::any_of(path.begin(), path.end(), [&](const Node& node) { return same(node, source); })) return;
                }
                cancelRetry(); remember(source);
            }
            else if (current && same(source, current->focus)) current.reset();
        } catch (...) { current.reset(); cancelRetry(); }
    }
    static bool shell(const Node& node) {
        try {
            const auto path = ancestors(node);
            const auto app = parent(path.empty() ? node : path.back());
            if (!app || role(app) != ATSPI_ROLE_APPLICATION) return false;
            Error error;
            std::unique_ptr<gchar, decltype(&g_free)> name(atspi_accessible_get_name(app.get(), &error.value), g_free);
            return name && std::string_view(name.get()) == "gnome-shell";
        } catch (...) { return false; } // An object gone meanwhile is handled as before.
    }
    void bootstrap() {
        auto desktop = own(atspi_get_desktop(0));
        if (!desktop) return;
        for (const auto& app : children(desktop, 500)) {
            for (const auto& window : children(app, 500)) {
                if (!state(window, ATSPI_STATE_ACTIVE)) continue;
                active = window; tried = 0; warm(); return;
            }
        }
    }
};
}
