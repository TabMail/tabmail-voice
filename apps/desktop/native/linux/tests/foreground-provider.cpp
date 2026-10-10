// This Source Code Form is subject to the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/accessibility.h"
#include <glib-unix.h>
#include <map>
#include <optional>
#include <string>
#include <unistd.h>

// Linked only into the test service. The real service main, Foreground callbacks,
// GLib retry timers, screen readers and IPC handlers run against this lazy provider.
namespace {
struct Item { AtspiRole role; AtspiAccessible* parent; std::string text; std::vector<AtspiAccessible*> live; std::optional<std::vector<AtspiAccessible*>> cache; };
std::map<AtspiAccessible*, Item> items;
AtspiAccessible *desktop, *apps[2], *windows[2], *documents[2], *fields[2], *secret;
// The Shell's own window and the actor that holds the keyboard for the dictation key.
AtspiAccessible *shellWindow, *shellPanel;
bool holding = false;
// Whether the Shell says which window has the focus (the extension's `Focus`, from version 3): each
// synthetic window by an id of its own, with its app's process.
bool shellFocus = false;
int active = 0, failures = 0;
bool exposed = false, loseFocusOnText = false, focusLost = false;
bool mutateSelectionOnText = false, containerFocused = false;
int selectionStart = -1, selectionEnd = -1;
unsigned calls[2] = {};
AtspiEventListenerCB callback;
gpointer callbackData;
int control, acknowledgments;
AtspiAccessible* node(AtspiRole role, AtspiAccessible* parent, std::string text = "") {
    auto value = static_cast<AtspiAccessible*>(g_object_new(ATSPI_TYPE_ACCESSIBLE, nullptr));
    items.emplace(value, Item{role, parent, std::move(text), {}, {}});
    if (parent) items.at(parent).live.push_back(value);
    return value;
}
AtspiAccessible* ref(AtspiAccessible* value) { return value ? static_cast<AtspiAccessible*>(g_object_ref(value)) : nullptr; }
void clear(AtspiAccessible* root) { if (!root) return; items.at(root).cache.reset(); for (auto child : items.at(root).live) clear(child); }
const std::vector<AtspiAccessible*>& children(AtspiAccessible* root) {
    auto& item = items.at(root);
    if (!item.cache) item.cache = ((root == windows[0] || root == windows[1]) && !exposed) ? std::vector<AtspiAccessible*>{} : item.live;
    return *item.cache;
}
void event(const char* type, AtspiAccessible* source, int detail1 = 0) {
    auto value = g_new0(AtspiEvent, 1);
    value->type = g_strdup(type); value->source = ref(source); value->detail1 = detail1;
    callback(value, callbackData);
}
void activate(int index, int failCount) {
    if (active >= 0) event("window:deactivate", windows[active]);
    active = index; failures = failCount; exposed = false; clear(windows[index]);
    event("window:activate", windows[index]);
}
gboolean command(gint fd, GIOCondition, gpointer) {
    char value;
    if (::read(fd, &value, 1) != 1) return G_SOURCE_REMOVE;
    if (value == 'l' || value == 'v' || value == 'q' || value == 'c' || value == 'U') {
        const auto before = value == 'v' ? std::string(300000, 'a') + ". Before " : std::string("Before ");
        std::string selected(value == 'q' ? 262139 : 20001, 'x');
        if (value == 'c' || value == 'U') {
            selected.clear();
            for (int i = 0; i < (value == 'U' ? 65535 : 7000); ++i) selected += value == 'U' ? "😀" : "😀é";
        }
        const auto after = value == 'v' ? std::string(" after! ") + std::string(300000, 'b') : std::string(" after");
        items.at(fields[active]).text = before + selected + after;
        selectionStart = before.size(); selectionEnd = selectionStart + g_utf8_strlen(selected.c_str(), -1);
    }
    if (value == 't') items.at(fields[active]).role = ATSPI_ROLE_TERMINAL;
    if (value == 'm') mutateSelectionOnText = true;
    if (value == 'z') {
        items.at(fields[active]).role = ATSPI_ROLE_ENTRY;
        items.at(fields[active]).text = "Synthetic field content";
        selectionStart = selectionEnd = -1; mutateSelectionOnText = false;
    }
    if (value == 'f') loseFocusOnText = true;
    if (value == 'g') { loseFocusOnText = false; focusLost = false; }
    if (value == 'a') activate(0, 0);
    if (value == 'b') activate(1, 0);
    if (value == 'r') activate(0, 1);
    if (value == 'e') activate(0, 99);
    if (value == 'o') {
        // LibreOffice's order: the field, then its container (focused only for a moment), then
        // the window; a lookup of the window would fail.
        if (active >= 0) event("window:deactivate", windows[active]);
        active = 0; failures = 99; exposed = true;
        event("object:state-changed:focused", fields[0], 1);
        containerFocused = true; event("object:state-changed:focused", documents[0], 1);
        event("window:activate", windows[0]);
        event("object:state-changed:focused", documents[0], 1); containerFocused = false;
    }
    if (value == 'd' && active >= 0) { event("window:deactivate", windows[active]); active = -1; }
    if (value == 'p') { items.at(fields[active]).live = {secret}; }
    // The Shell takes the keyboard for the dictation key, as GNOME reports it: its window and the
    // actor holding the keyboard get focus, the window in front loses it. Then it lets go.
    if (value == 'h' && active >= 0) {
        holding = true;
        event("window:activate", shellWindow); event("object:state-changed:focused", shellPanel, 1);
        focusLost = true; event("object:state-changed:focused", fields[active], 0); event("window:deactivate", windows[active]);
    }
    if (value == 'H' && active >= 0) {
        holding = false;
        event("object:state-changed:focused", shellPanel, 0); event("window:deactivate", shellWindow);
        focusLost = false; event("object:state-changed:focused", fields[active], 1); event("window:activate", windows[active]);
    }
    // The focus moves to the Shell's own window with no hold (its overview).
    if (value == 'S' && active >= 0) {
        event("window:activate", shellWindow); event("object:state-changed:focused", shellPanel, 1);
        focusLost = true; event("object:state-changed:focused", fields[active], 0);
    }
    if (value == 'u') items.at(fields[active]).live.clear();
    if (value == 'F') shellFocus = true;
    if (value == 'N') shellFocus = false;
    const auto reply = std::to_string(calls[0]) + " " + std::to_string(calls[1]) + "\n";
    if (::write(acknowledgments, reply.data(), reply.size()) != static_cast<ssize_t>(reply.size())) std::abort();
    return G_SOURCE_CONTINUE;
}
}
extern "C" int __wrap_atspi_init() {
    desktop = node(ATSPI_ROLE_DESKTOP_FRAME, nullptr);
    for (int i = 0; i < 2; ++i) {
        apps[i] = node(ATSPI_ROLE_APPLICATION, desktop);
        windows[i] = node(ATSPI_ROLE_FRAME, apps[i], "Synthetic window");
        node(ATSPI_ROLE_HEADING, windows[i], i ? "Second synthetic app" : "First synthetic app");
        documents[i] = node(ATSPI_ROLE_DOCUMENT_WEB, windows[i]);
        fields[i] = node(ATSPI_ROLE_ENTRY, documents[i], "Synthetic field content");
    }
    secret = node(ATSPI_ROLE_PASSWORD_TEXT, nullptr, "synthetic-private-password");
    shellWindow = node(ATSPI_ROLE_WINDOW, node(ATSPI_ROLE_APPLICATION, desktop, "gnome-shell"));
    shellPanel = node(ATSPI_ROLE_PANEL, shellWindow);
    control = std::stoi(g_getenv("VOICE_FIXTURE_CONTROL")); acknowledgments = std::stoi(g_getenv("VOICE_FIXTURE_ACK"));
    g_unix_fd_add(control, G_IO_IN, command, nullptr);
    return 0;
}
extern "C" void __wrap_atspi_event_main() { auto loop = g_main_loop_new(nullptr, FALSE); g_main_loop_run(loop); g_main_loop_unref(loop); }
extern "C" AtspiEventListener* __real_atspi_event_listener_new(AtspiEventListenerCB, gpointer, GDestroyNotify);
extern "C" AtspiEventListener* __wrap_atspi_event_listener_new(AtspiEventListenerCB cb, gpointer data, GDestroyNotify destroy) {
    callback = cb; callbackData = data; return __real_atspi_event_listener_new(cb, data, destroy);
}
// The Shell answers whether it holds the keyboard, and, once the fixture says so, which window has the
// focus; the helper's other Shell calls get no Shell.
extern "C" GVariant* __real_g_dbus_connection_call_sync(GDBusConnection*, const gchar*, const gchar*, const gchar*, const gchar*,
    GVariant*, const GVariantType*, GDBusCallFlags, gint, GCancellable*, GError**);
extern "C" GVariant* __wrap_g_dbus_connection_call_sync(GDBusConnection* bus, const gchar* name, const gchar* path, const gchar* interface,
    const gchar* method, GVariant* args, const GVariantType* type, GDBusCallFlags flags, gint timeout, GCancellable* cancel, GError** error) {
    if (std::string(method) == "Holding") return g_variant_ref_sink(g_variant_new("(b)", holding));
    if (std::string(method) == "Focus" && shellFocus)
        return g_variant_ref_sink(g_variant_new("(tu)", active >= 0 ? static_cast<guint64>(7000 + active) : guint64{0}, active >= 0 ? 4194305u + active : 0u));
    return __real_g_dbus_connection_call_sync(bus, name, path, interface, method, args, type, flags, timeout, cancel, error);
}
extern "C" gboolean __wrap_atspi_event_listener_register(AtspiEventListener*, const gchar*, GError**) { return TRUE; }
extern "C" gboolean __wrap_atspi_event_listener_deregister(AtspiEventListener*, const gchar*, GError**) { return TRUE; }
extern "C" AtspiAccessible* __wrap_atspi_get_desktop(gint) { return ref(desktop); }
extern "C" void __wrap_atspi_accessible_clear_cache(AtspiAccessible* root) { clear(root); }
extern "C" GHashTable* __wrap_atspi_accessible_get_attributes(AtspiAccessible* root, GError** error) {
    int index = root == windows[0] ? 0 : root == windows[1] ? 1 : -1;
    if (index < 0) std::abort();
    ++calls[index];
    if (failures > 0) { --failures; g_set_error_literal(error, g_quark_from_static_string("fixture"), 1, "busy"); return nullptr; }
    exposed = true;
    return g_hash_table_new(g_str_hash, g_str_equal);
}
extern "C" AtspiRole __wrap_atspi_accessible_get_role(AtspiAccessible* value, GError**) { return items.at(value).role; }
extern "C" AtspiStateSet* __wrap_atspi_accessible_get_state_set(AtspiAccessible* value) {
    auto states = atspi_state_set_new(nullptr);
    atspi_state_set_add(states, ATSPI_STATE_SHOWING);
    if (active >= 0 && value == windows[active]) atspi_state_set_add(states, ATSPI_STATE_ACTIVE);
    if (active >= 0 && containerFocused && value == documents[active]) atspi_state_set_add(states, ATSPI_STATE_FOCUSED);
    if (active >= 0 && exposed && !focusLost && value == fields[active]) { atspi_state_set_add(states, ATSPI_STATE_FOCUSED); atspi_state_set_add(states, ATSPI_STATE_EDITABLE); }
    return states;
}
extern "C" gint __wrap_atspi_accessible_get_child_count(AtspiAccessible* root, GError**) { return children(root).size(); }
extern "C" AtspiAccessible* __wrap_atspi_accessible_get_child_at_index(AtspiAccessible* root, gint index, GError**) { return ref(children(root).at(index)); }
extern "C" AtspiAccessible* __wrap_atspi_accessible_get_parent(AtspiAccessible* value, GError**) { return ref(items.at(value).parent); }
// Each synthetic app is a process of its own, past the kernel's largest pid (2^22), so no real
// process's launcher identity is looked up: the first app 4194305, the second 4194306.
extern "C" guint __wrap_atspi_accessible_get_process_id(AtspiAccessible* value, GError**) {
    for (auto node = value; node; node = items.at(node).parent)
        for (int i = 0; i < 2; ++i) if (node == apps[i]) return 4194305 + i;
    return 0;
}
extern "C" AtspiCollection* __wrap_atspi_accessible_get_collection_iface(AtspiAccessible*) { return nullptr; }
extern "C" AtspiComponent* __wrap_atspi_accessible_get_component_iface(AtspiAccessible* value) {
    if (active < 0 || items.at(fields[active]).role != ATSPI_ROLE_TERMINAL) return nullptr;
    return reinterpret_cast<AtspiComponent*>(ref(value));
}
extern "C" AtspiRect* __wrap_atspi_component_get_extents(AtspiComponent*, AtspiCoordType, GError**) {
    auto result=g_new0(AtspiRect,1);result->width=1000;result->height=800;return result;
}
extern "C" AtspiRect* __wrap_atspi_text_get_character_extents(AtspiText*,gint,AtspiCoordType,GError**) {
    auto result=g_new0(AtspiRect,1);result->x=10;result->y=10;result->width=8;result->height=16;return result;
}
extern "C" GArray* __wrap_atspi_text_get_bounded_ranges(AtspiText*,gint,gint,gint,gint,
    AtspiCoordType,AtspiTextClipType,AtspiTextClipType,GError**) {
    auto result=g_array_new(FALSE,FALSE,sizeof(AtspiTextRange));
    // The viewport displays a bounded selection interval, with earlier/later
    // document content off screen. Long selections extend beyond this viewport.
    AtspiTextRange span{selectionStart,std::min(selectionEnd,selectionStart+30000),g_strdup("synthetic visible interval")};
    g_array_append_val(result,span);return result;
}
extern "C" AtspiDocument* __wrap_atspi_accessible_get_document_iface(AtspiAccessible* value) { return reinterpret_cast<AtspiDocument*>(ref(value)); }
extern "C" GHashTable* __wrap_atspi_document_get_document_attributes(AtspiDocument*, GError**) {
    auto result = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
    g_hash_table_insert(result, g_strdup("URI"), g_strdup("https://synthetic.example/page")); return result;
}
extern "C" gchar* __wrap_atspi_accessible_get_name(AtspiAccessible* value, GError**) { if (value == secret) std::abort(); return g_strdup(items.at(value).text.c_str()); }
extern "C" AtspiText* __wrap_atspi_accessible_get_text_iface(AtspiAccessible* value) { if (value == secret || (active >= 0 && value == fields[active] && !items.at(value).live.empty())) std::abort(); return reinterpret_cast<AtspiText*>(ref(value)); }
extern "C" gint __wrap_atspi_text_get_character_count(AtspiText* value, GError**) { return g_utf8_strlen(items.at(reinterpret_cast<AtspiAccessible*>(value)).text.c_str(), -1); }
extern "C" gint __wrap_atspi_text_get_caret_offset(AtspiText* value, GError** error) { return selectionEnd >= 0 ? selectionEnd : __wrap_atspi_text_get_character_count(value, error); }
extern "C" gint __wrap_atspi_text_get_n_selections(AtspiText*, GError**) { return selectionStart >= 0 ? 1 : 0; }
extern "C" AtspiRange* __wrap_atspi_text_get_selection(AtspiText*, gint, GError**) {
    auto selected = g_new0(AtspiRange, 1);
    selected->start_offset = selectionStart; selected->end_offset = selectionEnd;
    return selected;
}
extern "C" gchar* __wrap_atspi_text_get_text(AtspiText* value, gint from, gint to, GError**) {
    // Both ordinary field and selection acquisition use this provider. The
    // dedicated live-source fixture asserts selection-only request boundaries.
    if (loseFocusOnText) focusLost = true;
    if (mutateSelectionOnText) { ++selectionStart; mutateSelectionOnText = false; }
    const auto& text = items.at(reinterpret_cast<AtspiAccessible*>(value)).text;
    return g_utf8_substring(text.c_str(), from, to);
}
