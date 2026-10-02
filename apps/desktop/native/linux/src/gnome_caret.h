// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
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
                (*reply)(version == 1, true);
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
    void read(Channel::Reply reply) {
        if (!state->bus) { reply(nullptr, true); return; }
        g_dbus_connection_call(state->bus.get(), "org.gnome.Shell", "/ai/tabmail/Voice/Caret",
            "ai.tabmail.Voice.Caret", "Read", nullptr, G_VARIANT_TYPE("(s)"),
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
