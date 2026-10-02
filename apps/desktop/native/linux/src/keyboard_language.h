// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <ibus.h>
#include "channel.h"
#include "accessibility.h"

namespace voice {
/** GNOME updates IBus's global engine for both XKB layouts and input methods.
 * Query the live engine, not the display locale or a saved layout preference. */
class KeyboardLanguage {
    Object<IBusBus> bus;
    Object<GCancellable> cancel;
public:
    KeyboardLanguage() {
        ibus_init();
        bus = own(ibus_bus_new_async());
        cancel = own(g_cancellable_new());
    }
    ~KeyboardLanguage() { g_cancellable_cancel(cancel.get()); }
    void read(Channel::Reply reply) {
        if (!bus || !ibus_bus_is_connected(bus.get())) { reply(nullptr, true); return; }
        ibus_bus_get_global_engine_async(bus.get(), 250, cancel.get(),
            [](GObject* source, GAsyncResult* result, gpointer data) {
                std::unique_ptr<Channel::Reply> reply(static_cast<Channel::Reply*>(data));
                Error error;
                auto engine = own(ibus_bus_get_global_engine_async_finish(IBUS_BUS(source), result, &error.value));
                const char* language = engine ? ibus_engine_desc_get_language(engine.get()) : nullptr;
                (*reply)(!error.value && language && *language ? nlohmann::json{{"code", language}} : nlohmann::json(nullptr), true);
            }, new Channel::Reply(std::move(reply)));
    }
};
}
