// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include <libecal/libecal.h>
#include <dlfcn.h>
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
// change saved just before the read), `changed` on every one (a source that keeps changing).
extern "C" void e_cal_client_view_start(ECalClientView* view, GError** error) {
    auto real = reinterpret_cast<decltype(&e_cal_client_view_start)>(dlsym(RTLD_NEXT, "e_cal_client_view_start"));
    if (!real) std::abort();
    real(view, error);
    static unsigned views = 0;
    const char* requested = std::getenv("VOICE_PRODUCTIVITY_FAULT");
    const bool always = requested && !std::strcmp(requested, "changed");
    const bool first = requested && !std::strcmp(requested, "changed-first") && views++ == 0;
    if ((!error || !*error) && (always || first)) g_signal_emit_by_name(view, "objects-modified", static_cast<GSList*>(nullptr));
}
