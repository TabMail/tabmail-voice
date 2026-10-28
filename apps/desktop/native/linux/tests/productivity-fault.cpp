// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include <libecal/libecal.h>
#include <dlfcn.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
namespace {
bool fail(const char* operation, GError** error) {
    const char* requested = std::getenv("VOICE_PRODUCTIVITY_FAULT");
    if (!requested || std::strcmp(requested, operation)) return false;
    g_set_error_literal(error, E_CLIENT_ERROR, E_CLIENT_ERROR_OTHER_ERROR, "synthetic provider failure");
    return true;
}
}
extern "C" gboolean e_cal_client_get_timezone_sync(ECalClient* client, const gchar* id, ICalTimezone** result, GCancellable* cancel, GError** error) {
    if (fail("timezone", error)) { *result = nullptr; return FALSE; }
    auto real = reinterpret_cast<decltype(&e_cal_client_get_timezone_sync)>(dlsym(RTLD_NEXT, "e_cal_client_get_timezone_sync"));
    if (!real) std::abort();
    return real(client, id, result, cancel, error);
}
extern "C" gboolean e_cal_client_get_objects_for_uid_sync(ECalClient* client, const gchar* id, GSList** result, GCancellable* cancel, GError** error) {
    if (fail("uid", error)) { *result = nullptr; return FALSE; }
    auto real = reinterpret_cast<decltype(&e_cal_client_get_objects_for_uid_sync)>(dlsym(RTLD_NEXT, "e_cal_client_get_objects_for_uid_sync"));
    if (!real) std::abort();
    return real(client, id, result, cancel, error);
}
// A change notice on a view as it starts: `changed-first` on the first view the process opens (a
// change saved just before the read), `changed` on every one (a source that keeps changing);
// `removed-first` and `removed` the same with a removal.
extern "C" void e_cal_client_view_start(ECalClientView* view, GError** error) {
    auto real = reinterpret_cast<decltype(&e_cal_client_view_start)>(dlsym(RTLD_NEXT, "e_cal_client_view_start"));
    if (!real) std::abort();
    real(view, error);
    static unsigned views = 0;
    const char* requested = std::getenv("VOICE_PRODUCTIVITY_FAULT");
    const bool always = requested && !std::strcmp(requested, "changed");
    const bool opening = views++ == 0;
    const bool first = requested && !std::strcmp(requested, "changed-first") && opening;
    const bool removed = requested && (!std::strcmp(requested, "removed") || (!std::strcmp(requested, "removed-first") && opening));
    if ((!error || !*error) && (always || first)) g_signal_emit_by_name(view, "objects-modified", static_cast<GSList*>(nullptr));
    if ((!error || !*error) && removed) g_signal_emit_by_name(view, "objects-removed", static_cast<GSList*>(nullptr));
}
namespace {
bool mode(const char* name) {
    const char* requested = std::getenv("VOICE_PRODUCTIVITY_FAULT");
    return requested && !std::strcmp(requested, name);
}
template <typename Function> Function next(const char* name) {
    auto real = reinterpret_cast<Function>(dlsym(RTLD_NEXT, name));
    if (!real) std::abort();
    return real;
}
}
// `server`: every calendar acts as one on a server that sends invitations, for the user me@example.com;
// `schedules`: one that sends them but doesn't know the user's address.
extern "C" gboolean e_client_check_capability(EClient* client, const gchar* capability) {
    if ((mode("server") || mode("schedules")) && !std::strcmp(capability, E_CAL_STATIC_CAPABILITY_SAVE_SCHEDULES)) return TRUE;
    return next<decltype(&e_client_check_capability)>("e_client_check_capability")(client, capability);
}
extern "C" gboolean e_client_get_backend_property_sync(EClient* client, const gchar* name, gchar** value, GCancellable* cancel, GError** error) {
    if (mode("server") && !std::strcmp(name, E_CAL_BACKEND_PROPERTY_CAL_EMAIL_ADDRESS)) { *value = g_strdup("me@example.com"); return TRUE; }
    return next<decltype(&e_client_get_backend_property_sync)>("e_client_get_backend_property_sync")(client, name, value, cancel, error);
}
// `readonly`: every calendar refuses writes.
extern "C" gboolean e_client_is_readonly(EClient* client) {
    if (mode("readonly")) return TRUE;
    return next<decltype(&e_client_is_readonly)>("e_client_is_readonly")(client);
}
// `nodefault`: there is no default calendar.
extern "C" ESource* e_source_registry_ref_default_calendar(ESourceRegistry* registry) {
    if (mode("nodefault")) return nullptr;
    return next<decltype(&e_source_registry_ref_default_calendar)>("e_source_registry_ref_default_calendar")(registry);
}
// `record`: the RECURRENCE-ID each split (THIS_AND_FUTURE) names is appended to the file
// VOICE_PRODUCTIVITY_RECORD names, as the backend receives it.
extern "C" gboolean e_cal_client_modify_object_sync(ECalClient* client, ICalComponent* component, ECalObjModType mod, ECalOperationFlags flags,
    GCancellable* cancel, GError** error) {
    const char* path = std::getenv("VOICE_PRODUCTIVITY_RECORD");
    if (mode("record") && path && mod == E_CAL_OBJ_MOD_THIS_AND_FUTURE) {
        ICalProperty* rid = i_cal_component_get_first_property(component, I_CAL_RECURRENCEID_PROPERTY);
        gchar* text = rid ? i_cal_property_as_ical_string(rid) : nullptr;
        if (FILE* file = std::fopen(path, "a")) { std::fputs(text ? text : "none\n", file); std::fclose(file); }
        g_free(text);
        if (rid) g_object_unref(rid);
    }
    return next<decltype(&e_cal_client_modify_object_sync)>("e_cal_client_modify_object_sync")(client, component, mod, flags, cancel, error);
}
