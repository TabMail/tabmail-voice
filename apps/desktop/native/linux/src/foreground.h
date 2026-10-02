// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "accessibility.h"
#include "identity.h"
#include <algorithm>
#include <iostream>

namespace voice {
// Focus/window events start one bounded visit. A successful query stops retries;
// losing focus cancels them. No permanent polling and no activation at key-down.
class Foreground {
public:
    static constexpr unsigned attempts = 5, retryMilliseconds = 1000;
    Foreground() {
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
private:
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
            if (type == "window:deactivate") {
                if (same(source, active) || same(source, tokenWindow)) { current.reset(); active.reset(); cancelRetry(); }
            }
            else if (type == "window:activate") {
                current.reset(); cancelRetry(); active = source; tried = 0; warm();
            } else if (event->detail1) { cancelRetry(); remember(source); }
            else if (current && same(source, current->focus)) current.reset();
        } catch (...) { current.reset(); cancelRetry(); }
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
