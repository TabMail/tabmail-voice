// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <gio/gio.h>
#include <functional>
#include <utility>

namespace voice {
// Portal sessions and Registry registration belong to one service owner. A
// crashed portal need not emit Session::Closed. End the helper on owner loss;
// HelperClient already clears permissions and restarts with fresh session state.
// Initial absence is not a loss, so an unavailable portal cannot cause a loop.
class PortalOwner {
    std::function<void()> lost;
    bool seen = false;
    guint watch;
public:
    explicit PortalOwner(std::function<void()> lost) : lost(std::move(lost)), watch(
        g_bus_watch_name(G_BUS_TYPE_SESSION, "org.freedesktop.portal.Desktop", G_BUS_NAME_WATCHER_FLAGS_NONE,
            [](GDBusConnection*, const gchar*, const gchar*, gpointer data) {
                static_cast<PortalOwner*>(data)->seen = true;
            },
            [](GDBusConnection*, const gchar*, gpointer data) {
                auto& self = *static_cast<PortalOwner*>(data);
                if (std::exchange(self.seen, false)) self.lost();
            }, this, nullptr)) {}
    ~PortalOwner() { g_bus_unwatch_name(watch); }
    PortalOwner(const PortalOwner&) = delete;
    PortalOwner& operator=(const PortalOwner&) = delete;
};
}
