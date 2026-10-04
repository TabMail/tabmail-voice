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
