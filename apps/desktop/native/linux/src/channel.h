// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <glib-unix.h>
#include <array>
#include <cerrno>
#include <fcntl.h>
#include <functional>
#include <unistd.h>
#include "output.h"

namespace voice {
// A bounded JSON-lines channel. Handlers may answer asynchronously, but replies
// always use the original id and the single serialized output writer.
class Channel {
public:
    using JSON = nlohmann::json;
    using Reply = std::function<void(JSON, bool)>;
    using Handler = std::function<void(const std::string&, const JSON&, Reply, int64_t)>;
    Channel(Output& writer, Handler handler) : writer(writer), handler(std::move(handler)) {
        const int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
        if (flags < 0 || fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) < 0)
            throw std::runtime_error("input unavailable");
        source = g_unix_fd_add(STDIN_FILENO, static_cast<GIOCondition>(G_IO_IN | G_IO_HUP | G_IO_ERR),
            [](gint fd, GIOCondition, gpointer value) { return static_cast<Channel*>(value)->read(fd); }, this);
    }
    ~Channel() { g_source_remove(source); }
private:
    Output& writer;
    Handler handler;
    std::string line;
    guint source = 0;
    void request() {
        const auto input = JSON::parse(line, nullptr, false);
        if (input.is_object() && input.value("method", JSON{}) == "cancel" && !input.contains("id")) {
            try { handler("cancel", input.value("params", JSON::object()), [](JSON, bool) {}, 0); }
            catch (...) {}
            return;
        }
        if (!input.is_object() || !input.contains("id") || !input["id"].is_number_integer() ||
            !input.contains("method") || !input["method"].is_string()) return;
        const auto reply = [this, id = input["id"]](JSON value, bool success) {
            writer.send(success ? JSON{{"id", id}, {"result", std::move(value)}}
                : JSON{{"id", id}, {"error", {{"message", "native request failed"}}}});
        };
        try { handler(input["method"].get<std::string>(), input.value("params", JSON::object()), reply, input["id"].get<int64_t>()); }
        catch (...) { reply(nullptr, false); } // Exception text may include private request data.
    }
    gboolean read(int fd) {
        std::array<char, 4096> bytes{};
        unsigned requests = 0;
        for (;;) {
            const auto count = ::read(fd, bytes.data(), bytes.size());
            // A closed parent must release microphone/shortcuts even if stdout is blocked.
            if (count == 0) std::_Exit(0);
            if (count < 0) {
                if (errno == EINTR) continue;
                if (errno == EAGAIN || errno == EWOULDBLOCK) return G_SOURCE_CONTINUE;
                std::_Exit(1);
            }
            for (ssize_t i = 0; i < count; ++i) {
                if (bytes[i] == '\n') {
                    if (++requests > 32) std::_Exit(1);
                    request(); line.clear();
                } else {
                    if (line.size() >= 1024 * 1024) std::_Exit(1);
                    line += bytes[i];
                }
            }
        }
    }
};
}
