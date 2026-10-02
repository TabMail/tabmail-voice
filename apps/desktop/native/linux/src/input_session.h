// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <gio/gio.h>
#include <gio/gunixinputstream.h>
#include <gio/gunixoutputstream.h>
#include "accessibility.h"
#include "output.h"
#include "portal_token.h"
#include <algorithm>
#include <functional>
#include <map>

namespace voice {
using Variant = std::shared_ptr<GVariant>;
inline Variant variant(GVariant* value) { return Variant(value, [](GVariant* item) { if (item) g_variant_unref(item); }); }
inline GVariant* options() { return g_variant_new_array(G_VARIANT_TYPE("{sv}"), nullptr, 0); }

// The stock Ubuntu libportal predates its Clipboard API. Use the public portal
// D-Bus contracts directly, with asynchronous, cancellable calls and FD streams.
// One session requests keyboard + clipboard only; no pointer or screen capture.
class InputSession {
public:
    using Completion = std::function<void(bool)>;
    using Bytes = std::shared_ptr<const std::vector<unsigned char>>;
    using Offer = std::map<std::string, Bytes>;
    struct Selection { uint64_t epoch = 0; bool known = false, ours = false; std::vector<std::string> formats; };
    struct State : std::enable_shared_from_this<State> {
        static constexpr const char* service = "org.freedesktop.portal.Desktop";
        static constexpr const char* desktop = "/org/freedesktop/portal/desktop";
        static constexpr const char* remote = "org.freedesktop.portal.RemoteDesktop";
        static constexpr const char* clipboard = "org.freedesktop.portal.Clipboard";
        Output& output;
        PortalToken tokenStore;
        bool registered = false;
        Object<GDBusConnection> bus;
        std::string session, requestPath, parentWindow;
        uint64_t generation = 0;
        Object<GCancellable> permissionCancel;
        guint responseSignal = 0, clipboardSignal = 0, closedSignal = 0, timeout = 0;
        bool granted = false;
        unsigned serial = 0, transfers = 0;
        Selection selection;
        Offer offer;
        std::vector<Completion> waiting;
        std::function<void()> onOwnerChange;
        using Call = std::function<void(Variant, Object<GUnixFDList>)>;
        explicit State(Output& output, std::string tokenPath) : output(output), tokenStore(std::move(tokenPath)) {
            Error error; bus = own(g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error.value));
            if (!bus || error.value) throw std::runtime_error("input portal unavailable");
        }
        void call(const char* path, const char* interface, const char* method, GVariant* args,
                  GCancellable* cancel, Call done, int milliseconds = 5000) {
            auto callback = new Call(std::move(done));
            g_dbus_connection_call_with_unix_fd_list(bus.get(), service, path, interface, method,
                args, nullptr, G_DBUS_CALL_FLAGS_NONE, milliseconds, nullptr, cancel,
                [](GObject* object, GAsyncResult* result, gpointer data) {
                    std::unique_ptr<Call> done(static_cast<Call*>(data));
                    Error error; GUnixFDList* descriptors = nullptr;
                    auto reply = variant(g_dbus_connection_call_with_unix_fd_list_finish(
                        G_DBUS_CONNECTION(object), &descriptors, result, &error.value));
                    (*done)(error.value ? Variant{} : reply, own(descriptors));
                }, callback);
        }
        void unsubscribe(guint& id) { if (id) g_dbus_connection_signal_unsubscribe(bus.get(), id); id = 0; }
        void close() {
            ++generation;
            granted = false;
            if (permissionCancel) g_cancellable_cancel(permissionCancel.get());
            if (!requestPath.empty()) call(requestPath.c_str(), "org.freedesktop.portal.Request", "Close", nullptr, nullptr, [](auto, auto) {});
            if (!session.empty()) call(session.c_str(), "org.freedesktop.portal.Session", "Close", nullptr, nullptr, [](auto, auto) {});
            session.clear(); requestPath.clear();
            unsubscribe(responseSignal); unsubscribe(clipboardSignal); unsubscribe(closedSignal);
            selection = {}; offer.clear();
        }
        void finish(bool success) {
            if (timeout) g_source_remove(timeout);
            timeout = 0;
            if (!success) close();
            permissionCancel.reset();
            granted = success;
            output.send({{"event", "insertionPermissionChanged"}, {"granted", success}});
            auto completions = std::move(waiting); waiting.clear();
            for (const auto& done : completions) done(success);
        }
        std::string token() { return "tabmail_" + std::to_string(g_random_int()) + "_" + std::to_string(++serial); }
        void requestResponse(const char* method, GVariant* args, const std::string& token, std::function<void(Variant)> done) {
            std::string sender = g_dbus_connection_get_unique_name(bus.get());
            sender.erase(0, 1); std::replace(sender.begin(), sender.end(), '.', '_');
            requestPath = std::string(desktop) + "/request/" + sender + "/" + token;
            struct Response { std::shared_ptr<State> self; std::function<void(Variant)> done; };
            responseSignal = g_dbus_connection_signal_subscribe(bus.get(), service, "org.freedesktop.portal.Request", "Response",
                requestPath.c_str(), nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
                [](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*, GVariant* value, gpointer data) {
                    auto response = static_cast<Response*>(data);
                    auto self = response->self;
                    auto done = std::move(response->done);
                    guint code = 2; GVariant* results = nullptr;
                    g_variant_get(value, "(u@a{sv})", &code, &results);
                    auto owned = variant(results);
                    self->unsubscribe(self->responseSignal); self->requestPath.clear();
                    done(code == 0 ? owned : Variant{});
                }, new Response{shared_from_this(), std::move(done)},
                [](gpointer data) { delete static_cast<Response*>(data); });
            auto self = shared_from_this();
            const auto visit = generation;
            call(desktop, remote, method, args, permissionCancel.get(), [self, visit](auto result, auto) {
                if (visit == self->generation && !result && self->permissionCancel) self->finish(false);
            });
        }
        void start() {
            auto self = shared_from_this();
            clipboardSignal = g_dbus_connection_signal_subscribe(bus.get(), service, clipboard, nullptr, desktop, nullptr,
                G_DBUS_SIGNAL_FLAGS_NONE, [](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar* signal, GVariant* value, gpointer data) {
                    auto self = static_cast<State*>(data);
                    const gchar* path = nullptr;
                    if (std::string(signal) == "SelectionOwnerChanged") {
                        GVariant* dictionary = nullptr;
                        g_variant_get(value, "(&o@a{sv})", &path, &dictionary);
                        auto owned = variant(dictionary);
                        if (self->session != path) return;
                        auto formats = variant(g_variant_lookup_value(dictionary, "mime_types", G_VARIANT_TYPE_STRING_ARRAY));
                        gboolean ours = false;
                        // GNOME emits an empty dictionary when the owner clears
                        // the selection. This explicit event proves emptiness;
                        // silence at session startup does not. Malformed events
                        // invalidate stale ownership rather than preserving it.
                        const bool cleared = g_variant_n_children(dictionary) == 0;
                        const bool valid = formats && g_variant_lookup(dictionary, "session_is_owner", "b", &ours);
                        self->selection.known = cleared || valid;
                        self->selection.ours = valid && ours;
                        ++self->selection.epoch;
                        self->selection.formats.clear();
                        if (valid) {
                            GVariantIter iterator; const gchar* format = nullptr;
                            g_variant_iter_init(&iterator, formats.get());
                            while (g_variant_iter_next(&iterator, "&s", &format)) {
                                if (self->selection.formats.size() >= 64 || strlen(format) > 256) {
                                    self->selection.known = false; self->selection.ours = false;
                                    self->selection.formats.clear(); break;
                                }
                                self->selection.formats.emplace_back(format);
                            }
                        }
                        if (!self->selection.ours) self->offer.clear();
                        if (self->onOwnerChange) self->onOwnerChange();
                    } else if (std::string(signal) == "SelectionTransfer") {
                        const gchar* mime = nullptr; guint serial = 0;
                        g_variant_get(value, "(&o&su)", &path, &mime, &serial);
                        if (self->session == path) self->transfer(mime, serial);
                    }
                }, this, nullptr);
            closedSignal = g_dbus_connection_signal_subscribe(bus.get(), service, "org.freedesktop.portal.Session", "Closed",
                session.c_str(), nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
                [](GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*, GVariant*, gpointer data) {
                    auto self = static_cast<State*>(data);
                    self->finish(false);
                }, this, nullptr);
            const auto requestToken = token();
            GVariantBuilder dictionary; g_variant_builder_init(&dictionary, G_VARIANT_TYPE_VARDICT);
            g_variant_builder_add(&dictionary, "{sv}", "handle_token", g_variant_new_string(requestToken.c_str()));
            requestResponse("Start", g_variant_new("(os@a{sv})", session.c_str(), parentWindow.c_str(), g_variant_builder_end(&dictionary)), requestToken,
                [self](Variant result) {
                    guint devices = 0; gboolean clipboardEnabled = false;
                    const bool accepted = result && g_variant_lookup(result.get(), "devices", "u", &devices) && (devices & 1) &&
                        g_variant_lookup(result.get(), "clipboard_enabled", "b", &clipboardEnabled) && clipboardEnabled;
                    const gchar* restore = nullptr;
                    if (accepted && g_variant_lookup(result.get(), "restore_token", "&s", &restore))
                        self->tokenStore.save(restore);
                    self->finish(accepted);
                });
        }
        void request(Completion done, std::string parent) {
            if (granted) { done(true); return; }
            if (waiting.size() >= 32) { done(false); return; }
            waiting.push_back(std::move(done));
            if (permissionCancel) return;
            close(); parentWindow = std::move(parent); permissionCancel = own(g_cancellable_new());
            timeout = g_timeout_add_seconds(180, [](gpointer data) -> gboolean {
                auto self = static_cast<State*>(data); self->timeout = 0; self->finish(false); return G_SOURCE_REMOVE;
            }, this);
            auto self = shared_from_this();
            if (registered) create();
            else call(desktop, "org.freedesktop.host.portal.Registry", "Register",
                g_variant_new("(s@a{sv})", "ai.tabmail.voice", options()), permissionCancel.get(),
                [self, visit = generation](auto result, auto) {
                    if (visit != self->generation) return;
                    if (!result) { self->finish(false); return; }
                    self->registered = true; self->create();
                });
        }
        void create() {
            auto self = shared_from_this();
            const auto requestToken = token(), sessionToken = token();
            GVariantBuilder dictionary; g_variant_builder_init(&dictionary, G_VARIANT_TYPE_VARDICT);
            g_variant_builder_add(&dictionary, "{sv}", "handle_token", g_variant_new_string(requestToken.c_str()));
            g_variant_builder_add(&dictionary, "{sv}", "session_handle_token", g_variant_new_string(sessionToken.c_str()));
            requestResponse("CreateSession", g_variant_new("(@a{sv})", g_variant_builder_end(&dictionary)), requestToken,
                [self](Variant result) {
                    const gchar* path = nullptr;
                    if (!result || !g_variant_lookup(result.get(), "session_handle", "&s", &path) || !g_variant_is_object_path(path)) { self->finish(false); return; }
                    self->session = path;
                    const auto requestToken = self->token();
                    GVariantBuilder dictionary; g_variant_builder_init(&dictionary, G_VARIANT_TYPE_VARDICT);
                    g_variant_builder_add(&dictionary, "{sv}", "handle_token", g_variant_new_string(requestToken.c_str()));
                    g_variant_builder_add(&dictionary, "{sv}", "types", g_variant_new_uint32(1));
                    g_variant_builder_add(&dictionary, "{sv}", "persist_mode", g_variant_new_uint32(2));
                    const auto restore = self->tokenStore.take();
                    if (!restore.empty()) g_variant_builder_add(&dictionary, "{sv}", "restore_token", g_variant_new_string(restore.c_str()));
                    self->requestResponse("SelectDevices", g_variant_new("(o@a{sv})", self->session.c_str(), g_variant_builder_end(&dictionary)), requestToken,
                        [self](Variant result) {
                            if (!result) { self->finish(false); return; }
                            const auto visit = self->generation;
                            self->call(desktop, clipboard, "RequestClipboard", g_variant_new("(o@a{sv})", self->session.c_str(), options()), self->permissionCancel.get(),
                                [self, visit](auto result, auto) { if (visit != self->generation) return; if (result) self->start(); else self->finish(false); });
                        });
                });
        }
        // Asynchronous stream lifetime owns its FD. Never block the GLib event loop
        // while another clipboard owner produces data or an app requests our offer.
        void read(const std::string& mime, GCancellable* cancel, std::function<void(Bytes)> done) {
            // Mutter refuses SelectionRead when this session owns the selection.
            // Restoration makes us the owner; its immutable bytes are already here.
            if (selection.known && selection.ours) {
                const auto found = offer.find(mime);
                done((cancel && g_cancellable_is_cancelled(cancel)) || found == offer.end() ? Bytes{} : found->second);
                return;
            }
            auto self = shared_from_this();
            auto cancellation = own(cancel ? G_CANCELLABLE(g_object_ref(cancel)) : g_cancellable_new());
            call(desktop, clipboard, "SelectionRead", g_variant_new("(os)", session.c_str(), mime.c_str()), cancellation.get(),
                [self, cancellation, done = std::move(done)](Variant result, Object<GUnixFDList> fds) mutable {
                    gint handle = -1; Error error;
                    if (!result || !fds || !g_variant_is_of_type(result.get(), G_VARIANT_TYPE("(h)"))) { done({}); return; }
                    g_variant_get(result.get(), "(h)", &handle);
                    const int fd = g_unix_fd_list_get(fds.get(), handle, &error.value);
                    if (fd < 0 || error.value) { done({}); return; }
                    struct Read : std::enable_shared_from_this<Read> {
                        Object<GInputStream> stream; Object<GCancellable> cancel;
                        std::vector<unsigned char> bytes; std::function<void(Bytes)> done;
                        void next() {
                            g_input_stream_read_bytes_async(stream.get(), 65536, G_PRIORITY_DEFAULT, cancel.get(),
                                [](GObject* stream, GAsyncResult* result, gpointer data) {
                                    std::unique_ptr<std::shared_ptr<Read>> holder(static_cast<std::shared_ptr<Read>*>(data));
                                    auto self = *holder; Error error;
                                    GBytes* chunk = g_input_stream_read_bytes_finish(G_INPUT_STREAM(stream), result, &error.value);
                                    if (!chunk) { self->done({}); return; }
                                    gsize size = 0; const auto bytes = static_cast<const unsigned char*>(g_bytes_get_data(chunk, &size));
                                    if (size > 64 * 1024 * 1024 - self->bytes.size()) { g_bytes_unref(chunk); self->done({}); return; }
                                    if (size) self->bytes.insert(self->bytes.end(), bytes, bytes + size);
                                    g_bytes_unref(chunk);
                                    if (size) self->next(); else self->done(std::make_shared<const std::vector<unsigned char>>(std::move(self->bytes)));
                                }, new std::shared_ptr<Read>(shared_from_this()));
                        }
                    };
                    auto reader = std::make_shared<Read>();
                    reader->stream = own(g_unix_input_stream_new(fd, true)); reader->cancel = cancellation; reader->done = std::move(done); reader->next();
                });
        }
        void publish(Offer bytes, GCancellable* cancel, Completion done) {
            GVariantBuilder dictionary; g_variant_builder_init(&dictionary, G_VARIANT_TYPE_VARDICT);
            std::vector<const char*> formats;
            for (const auto& [mime, data] : bytes) { (void)data; formats.push_back(mime.c_str()); }
            g_variant_builder_add(&dictionary, "{sv}", "mime_types", g_variant_new_strv(formats.data(), formats.size()));
            offer = std::move(bytes);
            auto self = shared_from_this();
            call(desktop, clipboard, "SetSelection", g_variant_new("(o@a{sv})", session.c_str(), g_variant_builder_end(&dictionary)), cancel,
                [self, done = std::move(done)](auto result, auto) { done(bool(result)); });
        }
        void transfer(const std::string& mime, guint serial) {
            auto self = shared_from_this();
            const auto found = offer.find(mime);
            auto finish = [self, serial](bool success) {
                self->call(desktop, clipboard, "SelectionWriteDone", g_variant_new("(oub)", self->session.c_str(), serial, success), nullptr, [](auto, auto) {});
            };
            if (found == offer.end() || transfers >= 32) { finish(false); return; }
            auto bytes = found->second;
            ++transfers;
            auto cancel = own(g_cancellable_new());
            auto timer = g_timeout_add_seconds_full(G_PRIORITY_DEFAULT, 5, [](gpointer data) -> gboolean {
                g_cancellable_cancel(G_CANCELLABLE(data)); return G_SOURCE_REMOVE;
            }, g_object_ref(cancel.get()), g_object_unref);
            call(desktop, clipboard, "SelectionWrite", g_variant_new("(ou)", session.c_str(), serial), cancel.get(),
                [self, bytes, cancel, timer, finish](Variant result, Object<GUnixFDList> fds) {
                    auto complete = [self, timer, finish](bool success) { if (g_main_context_find_source_by_id(nullptr, timer)) g_source_remove(timer); --self->transfers; finish(success); };
                    gint handle = -1; Error error;
                    if (!result || !fds || !g_variant_is_of_type(result.get(), G_VARIANT_TYPE("(h)"))) { complete(false); return; }
                    g_variant_get(result.get(), "(h)", &handle);
                    const int fd = g_unix_fd_list_get(fds.get(), handle, &error.value);
                    if (fd < 0 || error.value) { complete(false); return; }
                    struct Write { Object<GOutputStream> stream; Bytes bytes; Completion done; };
                    auto writer = new Write{own(g_unix_output_stream_new(fd, true)), bytes, complete};
                    g_output_stream_write_all_async(writer->stream.get(), bytes->data(), bytes->size(), G_PRIORITY_DEFAULT, cancel.get(),
                        [](GObject* stream, GAsyncResult* result, gpointer data) {
                            std::unique_ptr<Write> writer(static_cast<Write*>(data)); Error error; gsize written = 0;
                            const bool success = g_output_stream_write_all_finish(G_OUTPUT_STREAM(stream), result, &written, &error.value);
                            // FD closes before WriteDone; EOF is the consumer's completion signal.
                            writer->stream.reset(); writer->done(success && !error.value && written == writer->bytes->size());
                        }, writer);
                });
        }
        void key(int symbol, bool down, GCancellable* cancel, Completion done) {
            call(desktop, remote, "NotifyKeyboardKeysym", g_variant_new("(o@a{sv}iu)", session.c_str(), options(), symbol, unsigned(down)), cancel,
                [done = std::move(done)](auto result, auto) { done(bool(result)); }, 1000);
        }
    };
    explicit InputSession(Output& output, std::string tokenPath = {}) : state(std::make_shared<State>(output, std::move(tokenPath))) {}
    ~InputSession() { state->close(); }
    bool ready() const { return state->granted; }
    void restore(Completion done) {
        if (!ready() && !state->tokenStore.available()) { done(false); return; }
        state->request(std::move(done), "");
    }
    void request(Completion done, std::string parent = "") { state->request(std::move(done), std::move(parent)); }
    std::shared_ptr<State> state;
};
}
