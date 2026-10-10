// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <array>
#include <optional>
#include <utility>
#include <cmath>
#include <cstring>
#include "accessibility.h"
#include "channel.h"

namespace voice {
/** Optional compositor geometry. No accessibility traversal, activation, or retry
 * at key-down. An absent/busy extension uses the normal placement fallback. */
class GnomeCaret {
    struct State {
        Object<GDBusConnection> bus;
        Object<GCancellable> cancel = own(g_cancellable_new());
    };
    std::shared_ptr<State> state = std::make_shared<State>();
public:
    static constexpr int timeoutMilliseconds = 25;
    /** Which window is in front decides whether a paste goes ahead: the Shell gets longer to say it
     * than to place a caret, a busy Shell (a slow machine) missing 25 ms. */
    static constexpr int focusTimeoutMilliseconds = 250;
    GnomeCaret() {
        g_bus_get(G_BUS_TYPE_SESSION, state->cancel.get(), [](GObject*, GAsyncResult* result, gpointer data) {
            std::unique_ptr<std::shared_ptr<State>> state(static_cast<std::shared_ptr<State>*>(data));
            Error error;
            (*state)->bus = own(g_bus_get_finish(result, &error.value));
        }, new std::shared_ptr<State>(state));
    }
    ~GnomeCaret() { g_cancellable_cancel(state->cancel.get()); }
    GnomeCaret(const GnomeCaret&) = delete;
    GnomeCaret& operator=(const GnomeCaret&) = delete;

    void integration(Channel::Reply reply) {
        if (!state->bus) { reply(false, true); return; }
        g_dbus_connection_call(state->bus.get(), "org.gnome.Shell", "/ai/tabmail/Voice/Caret",
            "ai.tabmail.Voice.Caret", "Version", nullptr, G_VARIANT_TYPE("(u)"),
            G_DBUS_CALL_FLAGS_NO_AUTO_START, 250, state->cancel.get(),
            [](GObject* source, GAsyncResult* result, gpointer data) {
                std::unique_ptr<Channel::Reply> reply(static_cast<Channel::Reply*>(data));
                Error error;
                auto value = g_dbus_connection_call_finish(G_DBUS_CONNECTION(source), result, &error.value);
                guint version = 0;
                if (value) { g_variant_get(value, "(u)", &version); g_variant_unref(value); }
                // 3: the extension says which window has the focus (Focus); 2 added holding Right Alt
                // (SetHotkey, Holding). A Shell still running an older extension until the next login is
                // not ready, so Settings asks for one.
                (*reply)(version == 3, true);
            }, new Channel::Reply(std::move(reply)));
    }

    static nlohmann::json geometry(const char* text) {
        using JSON = nlohmann::json;
        if (!text || strnlen(text, 513) > 512) return nullptr;
        const auto result = JSON::parse(text, nullptr, false);
        if (!result.is_object()) return nullptr;
        JSON rect = JSON::object();
        for (const auto* key : {"x", "y", "width", "height"}) {
            if (!result.contains(key) || !result[key].is_number()) return nullptr;
            const double value = result[key].get<double>();
            if (!std::isfinite(value) || std::abs(value) > 10000000) return nullptr;
            rect[key] = value;
        }
        if (rect["width"].get<double>() <= 0 || rect["height"].get<double>() <= 0) return nullptr;
        return rect;
    }
    /** The input method's caret rectangle of the focused window. */
    void read(Channel::Reply reply) { rectangle("Read", nullptr, std::move(reply)); }
    /** `caret`, in the focused window's AT-SPI coordinates, on the screen. Asked and answered before
     * returning (at most `timeoutMilliseconds`): the helper's next request, a screen read that holds
     * the main loop for as long as it takes, must not hold this answer back. */
    nlohmann::json fromWindow(const std::array<int, 4>& caret) {
        if (!state->bus) return nullptr;
        Error error;
        auto value = g_dbus_connection_call_sync(state->bus.get(), "org.gnome.Shell", "/ai/tabmail/Voice/Caret",
            "ai.tabmail.Voice.Caret", "FromWindow", g_variant_new("(dddd)", double(caret[0]), double(caret[1]), double(caret[2]), double(caret[3])),
            G_VARIANT_TYPE("(s)"), G_DBUS_CALL_FLAGS_NO_AUTO_START, timeoutMilliseconds, state->cancel.get(), &error.value);
        if (!value) return nullptr;
        const char* text = nullptr;
        g_variant_get(value, "(&s)", &text);
        auto rect = geometry(text);
        g_variant_unref(value);
        return rect;
    }
    /** Whether the Shell holds the keyboard for the dictation key, held down now (asked and answered
     * before returning, at most `timeoutMilliseconds`). The window in front has no keyboard focus
     * meanwhile, yet it stays the dictation's target. No Shell, or no answer: false. */
    bool holding() {
        if (!state->bus) return false;
        Error error;
        auto value = g_dbus_connection_call_sync(state->bus.get(), "org.gnome.Shell", "/ai/tabmail/Voice/Caret",
            "ai.tabmail.Voice.Caret", "Holding", nullptr, G_VARIANT_TYPE("(b)"), G_DBUS_CALL_FLAGS_NO_AUTO_START,
            timeoutMilliseconds, state->cancel.get(), &error.value);
        if (!value) return false;
        gboolean held = FALSE;
        g_variant_get(value, "(b)", &held);
        g_variant_unref(value);
        return held;
    }
    /** The window with the keyboard focus, by the Shell (`Focus`): its id and process. Asked and answered
     * before returning, at most `focusTimeoutMilliseconds`. No Shell or no answer: none. No window, or the
     * screen locked: 0, 0, an answer, by which nothing is in front (not a reason to ask accessibility). */
    std::optional<std::pair<uint64_t, unsigned>> focus() {
        if (!state->bus) return std::nullopt;
        Error error;
        auto value = g_dbus_connection_call_sync(state->bus.get(), "org.gnome.Shell", "/ai/tabmail/Voice/Caret",
            "ai.tabmail.Voice.Caret", "Focus", nullptr, G_VARIANT_TYPE("(tu)"), G_DBUS_CALL_FLAGS_NO_AUTO_START,
            focusTimeoutMilliseconds, state->cancel.get(), &error.value);
        if (!value) return std::nullopt;
        guint64 window = 0;
        guint32 pid = 0;
        g_variant_get(value, "(tu)", &window, &pid);
        g_variant_unref(value);
        return std::make_pair(static_cast<uint64_t>(window), window ? static_cast<unsigned>(pid) : 0u);
    }
private:
    void rectangle(const char* method, GVariant* args, Channel::Reply reply) {
        if (!state->bus) { if (args) g_variant_unref(g_variant_ref_sink(args)); reply(nullptr, true); return; }
        g_dbus_connection_call(state->bus.get(), "org.gnome.Shell", "/ai/tabmail/Voice/Caret",
            "ai.tabmail.Voice.Caret", method, args, G_VARIANT_TYPE("(s)"),
            G_DBUS_CALL_FLAGS_NO_AUTO_START, timeoutMilliseconds, state->cancel.get(),
            [](GObject* source, GAsyncResult* result, gpointer data) {
                std::unique_ptr<Channel::Reply> reply(static_cast<Channel::Reply*>(data));
                Error error;
                auto value = g_dbus_connection_call_finish(G_DBUS_CONNECTION(source), result, &error.value);
                nlohmann::json rect = nullptr;
                if (value) {
                    const char* text = nullptr;
                    g_variant_get(value, "(&s)", &text);
                    rect = geometry(text);
                    g_variant_unref(value);
                }
                (*reply)(std::move(rect), true);
            }, new Channel::Reply(std::move(reply)));
    }
};
}
