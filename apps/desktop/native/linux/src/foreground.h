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
#include <optional>
#include <string>
#include <nlohmann/json.hpp>
#include <string_view>
#include <utility>
#include <vector>

namespace voice {
// Focus/window events start one bounded visit. A successful query stops retries;
// losing focus cancels them. No permanent polling and no activation at key-down.
class Foreground {
public:
    static constexpr unsigned attempts = 5, retryMilliseconds = 1000;
    /** The window with the keyboard focus and its process, by the Shell (`GnomeCaret::focus`); window 0 where
     * the Shell says none is (the screen locked); none where the Shell doesn't say. */
    using ShellFocus = std::function<std::optional<std::pair<uint64_t, unsigned>>()>;
    /** `shellHolds`: whether the Shell holds the keyboard for the dictation key (`GnomeCaret::holding`).
     * `shellFocus`: which window is in front, where the Shell says (GNOME integration); accessibility
     * then says only what in it has the focus, and each app's own way of announcing its windows (two
     * accessible apps in Firefox, a window announced before its focus) no longer decides a paste. */
    Foreground(std::function<bool()> shellHolds, ShellFocus shellFocus) : shellHolds(std::move(shellHolds)), shellFocus(std::move(shellFocus)) {
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
    /** `pid`: the window's process, the identity voice-field-reader shares with this process (window
     * tokens are each process's own); 0 where the bus gives none. `shellWindow`: the Shell's id for the
     * window the focus came in, where the Shell named one of its process (or of a sandboxed app, whose
     * focus comes through its bus proxy) then; else 0. */
    struct Target { uint64_t token; Node focus; std::optional<AppIdentity> app; bool terminal = false; unsigned pid = 0; uint64_t shellWindow = 0; };
    /** What has the focus, in the window in front: by the Shell's window id where it says which that is.
     * The focus is that window's only while it is focused, or, while the Shell holds the keyboard for the
     * dictation key (GTK 4 drops the focus meanwhile), if it came in that very window: a process is not a
     * window, and a field of its other window is never named for this one. */
    std::optional<Target> target() const {
        if (const auto focus = shellFocus()) return inWindow(*focus);
        return current;
    }
    /** The window in front and the process accessibility names for it (`Target::pid`): the Shell's
     * window, or else the focus's own (`target`, `targets`). */
    std::optional<std::pair<uint64_t, unsigned>> front() const {
        // Past the dictation key's hold, a window whose focus accessibility doesn't name is not the
        // target (the dictation ends in the not-pasted note); during it, the Shell's window is.
        if (const auto focus = shellFocus()) {
            if (const auto target = inWindow(*focus)) return std::make_pair(target->token, target->pid);
            return focus->first && shellHolds() ? focus : std::nullopt;
        }
        if (current && targets(current->token)) return std::make_pair(current->token, current->pid);
        return std::nullopt;
    }
    /** Whether a paste may go to `token`'s window: it has the keyboard, and what in it has the focus is
     * known (where the Shell says which window is in front, one accessibility can't see, a terminal
     * among them, has no known field, nor what its paste keys are). Never while the Shell holds the
     * keyboard for the dictation key: a paste then reaches no window. */
    bool matches(uint64_t token) const {
        if (const auto focus = shellFocus()) {
            const auto target = inWindow(*focus);
            return target && target->token == token && !shellHolds();
        }
        return current && current->token == token && state(current->focus, ATSPI_STATE_FOCUSED);
    }
    /** `matches`, or the Shell holds the keyboard for the dictation key: the window in front has no
     * keyboard focus meanwhile, yet it is still the target. Not for an insertion: a paste while the
     * Shell holds the keyboard reaches no window. */
    bool targets(uint64_t token) const {
        if (const auto focus = shellFocus()) return focus->first && focus->first == token;
        return matches(token) || (current && current->token == token && shellHolds());
    }
private:
    std::function<bool()> shellHolds;
    ShellFocus shellFocus;
    /** `target` in the window the Shell says is in front (`focus`). */
    std::optional<Target> inWindow(const std::pair<uint64_t, unsigned>& focus) const {
        if (!focus.first || !current || (current->pid != focus.second && current->shellWindow != focus.first)) return std::nullopt;
        if (current->shellWindow && current->shellWindow != focus.first) return std::nullopt;
        if (!state(current->focus, ATSPI_STATE_FOCUSED) && !(current->shellWindow == focus.first && shellHolds())) return std::nullopt;
        auto target = *current;
        target.token = focus.first;
        return target;
    }
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
        const auto window = windowOf(path);
        if (!window) { current.reset(); return; }
        // The dictation target is the original app/window, not the original field
        // or caret. Moving between fields in that window must keep its identity.
        if (!same(tokenWindow, *window)) { tokenWindow = *window; windowToken = ++next; }
        Error error;
        const auto pid = atspi_accessible_get_process_id(focus.get(), &error.value);
        error.check(); // This queries the accessibility bus daemon, not the target application.
        const bool terminal = role(focus) == ATSPI_ROLE_TERMINAL ||
            std::any_of(path.begin(), path.end(), [](const Node& node) { return role(node) == ATSPI_ROLE_TERMINAL; });
        // The Shell has given the window the keyboard by the time its app says what in it has the focus.
        // A sandboxed app's focus comes through its bus proxy, whose process is never its window's: its
        // window is the one in front as the focus comes.
        const auto shellWindow = shellFocus();
        current = Target{windowToken, focus, desktopIdentity(pid), terminal, pid,
            shellWindow && shellWindow->first && (shellWindow->second == pid || busProxy(pid)) ? shellWindow->first : 0};
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
                // Where the Shell says which window is in front, the focus a window had is kept for when
                // it comes back: Firefox gives it up as the dictation key's hold begins.
                if (shellFocus()) return;
                if (same(source, active) || same(source, tokenWindow)) { current.reset(); active.reset(); cancelRetry(); }
            }
            else if (type == "window:activate") {
                // The target's own window again: the target stays. An app can announce its focused
                // element before its window (LibreOffice), or after it as the Shell lets the keyboard go
                // after the dictation key (Firefox). Walking a large page for the focus meanwhile (Gmail)
                // ran out of time and dropped the target just as the paste asked for it, so the walk
                // waits for the focus to come back by itself.
                if (current && same(source, tokenWindow)) {
                    cancelRetry(); active = source;
                    if (!state(current->focus, ATSPI_STATE_FOCUSED)) {
                        tried = 0;
                        retry = g_timeout_add(retryMilliseconds, [](gpointer data) -> gboolean {
                            auto self = static_cast<Foreground*>(data); self->retry = 0;
                            if (!self->current || !state(self->current->focus, ATSPI_STATE_FOCUSED)) self->warm();
                            return G_SOURCE_REMOVE;
                        }, this);
                    }
                    return;
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

/** `frontmostApp`'s reply: `{window, pid}`, the window in front and its process (`Foreground::front`), by
 * which voice-field-reader is asked for the field pasted into; or null. Where the Shell says, the window
 * is the Shell's own id for it, the same in every helper. */
inline nlohmann::json frontmostApp(const Foreground& foreground) {
    const auto front = foreground.front();
    // Opaque window ids, never window titles or field text.
    std::cerr << "debug accessibility: frontmost target " << (front ? std::to_string(front->first) : "unavailable") << "\n";
    return front ? nlohmann::json{{"window", front->first}, {"pid", front->second}} : nlohmann::json(nullptr);
}
}
