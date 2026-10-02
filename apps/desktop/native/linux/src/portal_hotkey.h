// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "input_session.h"
#include <set>

namespace voice {
// GNOME permits ordinary applications to bind shortcuts through this portal;
// its AT-SPI keyboard monitor is restricted to approved assistive applications.
class PortalHotkey {
    struct State : std::enable_shared_from_this<State> {
        static constexpr const char* service = "org.freedesktop.portal.Desktop";
        static constexpr const char* path = "/org/freedesktop/portal/desktop";
        static constexpr const char* interface = "org.freedesktop.portal.GlobalShortcuts";
        Output& output;
        Gesture& gesture;
        std::function<void(Action)> action;
        Object<GDBusConnection> bus;
        Object<GCancellable> cancel;
        std::string session, requestPath, choice, shortcut;
        guint signal = 0, closed = 0, response = 0, timeout = 0;
        uint64_t generation = 0;
        bool registered = false, installed = false, busy = false, modeHold = false, modeDown = false;
        Channel::Reply pending;
        explicit State(Output& output, Gesture& gesture) : output(output), gesture(gesture) {
            Error error; bus = own(g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error.value));
            if (!bus || error.value) throw std::runtime_error("shortcut portal unavailable");
        }
        using Call = std::function<void(Variant)>;
        void call(const char* object, const char* api, const char* method, GVariant* args, Call done) {
            const auto visit = generation;
            auto self = shared_from_this();
            g_dbus_connection_call(bus.get(), service, object, api, method, args, nullptr,
                G_DBUS_CALL_FLAGS_NONE, 5000, cancel.get(), [](GObject* source, GAsyncResult* result, gpointer data) {
                    std::unique_ptr<Call> done(static_cast<Call*>(data)); Error error;
                    auto value = variant(g_dbus_connection_call_finish(G_DBUS_CONNECTION(source), result, &error.value));
                    (*done)(error.value ? Variant{} : value);
                }, new Call([self, visit, done = std::move(done)](Variant value) {
                    if (visit == self->generation) done(value);
                }));
        }
        void unsubscribe(guint& id) { if (id) g_dbus_connection_signal_unsubscribe(bus.get(), id); id = 0; }
        void close() {
            ++generation;
            if (cancel) g_cancellable_cancel(cancel.get());
            if (timeout) g_source_remove(timeout);
            timeout = 0;
            for (auto object : {session, requestPath}) if (!object.empty())
                g_dbus_connection_call(bus.get(), service, object.c_str(), object == session ? "org.freedesktop.portal.Session" : "org.freedesktop.portal.Request", "Close", nullptr, nullptr, G_DBUS_CALL_FLAGS_NONE, 5000, nullptr, nullptr, nullptr);
            session.clear(); requestPath.clear(); unsubscribe(signal); unsubscribe(closed); unsubscribe(response);
            if (gesture.active()) output.action(Action::cancel);
            const bool chat = gesture.chatOpen; const auto tap = gesture.tapMaxDuration, window = gesture.doubleTapWindow;
            gesture = Gesture{}; gesture.chatOpen = chat; gesture.tapMaxDuration = tap; gesture.doubleTapWindow = window;
            installed = false; busy = false; modeHold = false; modeDown = false;
            if (pending) { auto reply = std::move(pending); pending = {}; reply({{"installed", false}}, true); }
        }
        void finish(bool success) {
            if (timeout) g_source_remove(timeout);
            timeout = 0; busy = false; installed = success;
            auto reply = std::move(pending); pending = {};
            if (!success) close();
            output.send({{"event", "hotkeyInstallationChanged"}, {"installed", success}});
            if (reply) reply({{"installed", success}}, true);
        }
        std::string token() { return "tabmail_" + std::to_string(g_random_int()); }
        void request(const char* method, GVariant* args, const std::string& token, Call done) {
            std::string sender = g_dbus_connection_get_unique_name(bus.get());
            sender.erase(0, 1); std::replace(sender.begin(), sender.end(), '.', '_');
            requestPath = std::string(path) + "/request/" + sender + "/" + token;
            auto self = shared_from_this();
            auto callback = new Call(std::move(done));
            response = g_dbus_connection_signal_subscribe(bus.get(), service, "org.freedesktop.portal.Request", "Response", requestPath.c_str(), nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
                [](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*, GVariant* value, gpointer data) {
                    auto pair = static_cast<std::pair<std::shared_ptr<State>, Call*>*>(data);
                    auto self = pair->first; auto done = std::move(*pair->second);
                    guint code = 2; GVariant* details = nullptr; g_variant_get(value, "(u@a{sv})", &code, &details);
                    auto owned = variant(details); self->unsubscribe(self->response); self->requestPath.clear();
                    done(code == 0 ? owned : Variant{});
                }, new std::pair<std::shared_ptr<State>, Call*>(self, callback), [](gpointer data) {
                    auto pair = static_cast<std::pair<std::shared_ptr<State>, Call*>*>(data); delete pair->second; delete pair;
                });
            call(path, interface, method, args, [self](Variant result) { if (!result && self->busy) self->finish(false); });
        }
        bool contains(Variant result) {
            if (!result) return false;
            auto shortcuts = variant(g_variant_lookup_value(result.get(), "shortcuts", G_VARIANT_TYPE("a(sa{sv})")));
            if (!shortcuts) return false;
            std::set<std::string> found;
            GVariantIter iterator; g_variant_iter_init(&iterator, shortcuts.get());
            const gchar* id = nullptr; GVariant* properties = nullptr;
            while (g_variant_iter_next(&iterator, "(&s@a{sv})", &id, &properties)) {
                auto owned = variant(properties); found.insert(id);
            }
            return found.contains(shortcut) && found.contains("mode-" + choice) && found.contains("cancel-" + choice);
        }
        void bind(std::string parent) {
            auto self = shared_from_this(); const auto handle = token();
            GVariantBuilder shortcuts; g_variant_builder_init(&shortcuts, G_VARIANT_TYPE("a(sa{sv})"));
            const std::vector<std::tuple<std::string, std::string, std::string>> bindings{
                {shortcut, "Dictate with TabMail Voice", choice},
                {"mode-" + choice, "TabMail Voice: agent mode", "SHIFT+" + choice},
                {"cancel-" + choice, "TabMail Voice: cancel or close", "CTRL+SHIFT+" + choice},
            };
            for (const auto& [id, label, trigger] : bindings) {
                GVariantBuilder description; g_variant_builder_init(&description, G_VARIANT_TYPE_VARDICT);
                g_variant_builder_add(&description, "{sv}", "description", g_variant_new_string(label.c_str()));
                g_variant_builder_add(&description, "{sv}", "preferred_trigger", g_variant_new_string(trigger.c_str()));
                g_variant_builder_add(&shortcuts, "(s@a{sv})", id.c_str(), g_variant_builder_end(&description));
            }
            GVariantBuilder dictionary; g_variant_builder_init(&dictionary, G_VARIANT_TYPE_VARDICT);
            g_variant_builder_add(&dictionary, "{sv}", "handle_token", g_variant_new_string(handle.c_str()));
            request("BindShortcuts", g_variant_new("(o@a(sa{sv})s@a{sv})", session.c_str(), g_variant_builder_end(&shortcuts), parent.c_str(), g_variant_builder_end(&dictionary)), handle,
                [self](Variant result) { self->finish(self->contains(result)); });
        }
        void create(std::string parent) {
            auto self = shared_from_this(); const auto handle = token(), sessionToken = token();
            GVariantBuilder dictionary; g_variant_builder_init(&dictionary, G_VARIANT_TYPE_VARDICT);
            g_variant_builder_add(&dictionary, "{sv}", "handle_token", g_variant_new_string(handle.c_str()));
            g_variant_builder_add(&dictionary, "{sv}", "session_handle_token", g_variant_new_string(sessionToken.c_str()));
            request("CreateSession", g_variant_new("(@a{sv})", g_variant_builder_end(&dictionary)), handle,
                [self, parent](Variant result) {
                    const gchar* session = nullptr;
                    if (!result || !g_variant_lookup(result.get(), "session_handle", "&s", &session) || !g_variant_is_object_path(session)) { self->finish(false); return; }
                    self->session = session;
                    self->signal = g_dbus_connection_signal_subscribe(self->bus.get(), service, interface, nullptr, path, nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
                        [](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar* name, GVariant* value, gpointer data) {
                            auto self = static_cast<State*>(data);
                            if (!self->installed || (std::string(name) != "Activated" && std::string(name) != "Deactivated") || !g_variant_is_of_type(value, G_VARIANT_TYPE("(osta{sv})"))) return;
                            const gchar *session, *id; guint64 timestamp; GVariant* details;
                            g_variant_get(value, "(&o&st@a{sv})", &session, &id, &timestamp, &details); g_variant_unref(details);
                            if (self->session != session) return;
                            const bool down = std::string(name) == "Activated";
                            const double time = static_cast<double>(timestamp) / 1000.0;
                            const auto emit = [self](std::optional<Action> action) { if (action) { if (self->action) self->action(*action); else self->output.action(*action); } };
                            if (self->shortcut == id) emit(self->gesture.modifier(down, time));
                            else if ("mode-" + self->choice == id) {
                                if (self->modeDown == down) return; // Ignore autorepeat and unmatched releases.
                                self->modeDown = down;
                                if (down) {
                                    self->modeHold = !self->gesture.active();
                                    if (self->modeHold) emit(self->gesture.modifier(true, time));
                                    emit(self->gesture.keyPressed(32, false));
                                } else if (self->modeHold) {
                                    self->modeHold = false; emit(self->gesture.modifier(false, time));
                                }
                            } else if ("cancel-" + self->choice == id && down) emit(self->gesture.keyPressed(27, false));
                        }, self.get(), nullptr);
                    self->closed = g_dbus_connection_signal_subscribe(self->bus.get(), service, "org.freedesktop.portal.Session", "Closed", session, nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
                        [](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*, GVariant*, gpointer data) { static_cast<State*>(data)->finish(false); }, self.get(), nullptr);
                    // ListShortcuts describes this session, not the compositor's saved
                    // approvals. Bind every new session; GNOME restores existing IDs
                    // without a dialog and asks only when new shortcuts need consent.
                    self->bind(parent);
                });
        }
        void setup(std::string parent, Channel::Reply reply = {}) {
            if (installed) { if (reply) reply({{"installed", true}}, true); return; }
            if (busy) { if (reply) reply({{"installed", false}}, true); return; }
            busy = true; pending = std::move(reply); cancel = own(g_cancellable_new());
            timeout = g_timeout_add_seconds(180, [](gpointer data) -> gboolean {
                auto self = static_cast<State*>(data); self->timeout = 0; self->finish(false); return G_SOURCE_REMOVE;
            }, this);
            auto self = shared_from_this();
            if (registered) create(parent);
            else call(path, "org.freedesktop.host.portal.Registry", "Register", g_variant_new("(s@a{sv})", "ai.tabmail.voice", options()),
                [self, parent](Variant value) { if (!value) { self->finish(false); return; } self->registered = true; self->create(parent); });
        }
    };
    std::shared_ptr<State> state;
public:
    PortalHotkey(Output& output, Gesture& gesture, std::function<void(Action)> action = {}) : state(std::make_shared<State>(output, gesture)) { state->action = std::move(action); }
    ~PortalHotkey() { state->close(); }
    bool configure(const std::string& choice) {
        if (state->choice != choice) { state->close(); state->choice = choice; state->shortcut = "dictation-" + choice; }
        state->setup(""); return state->installed;
    }
    bool ready() const { return state->installed; }
    bool busy() const { return state->busy; }
    void authorize(std::string parent, Channel::Reply reply) {
        if (state->choice.empty()) { reply({{"installed", false}}, true); return; }
        if (state->busy && !state->pending) state->close(); // Supersede quiet restoration with the user's request.
        state->setup(std::move(parent), std::move(reply));
    }
};
}
