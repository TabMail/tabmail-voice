// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include <libebook/libebook.h>
#include "../../shared/productivity/process.h"
#include "helper_config.h"
#include <libecal/libecal.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <functional>
#include <memory>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using JSON = nlohmann::json;
template<class T> using Object = std::unique_ptr<T, decltype(&g_object_unref)>;
using String = std::unique_ptr<gchar, decltype(&g_free)>;
struct Error {
    GError* value = nullptr;
    ~Error() { if (value) g_error_free(value); }
    void check(bool success = true) const {
        if (value || !success) throw std::runtime_error("provider unavailable");
    }
};
struct Sources {
    GList* value;
    ~Sources() { g_list_free_full(value, g_object_unref); }
};
struct Contacts {
    GSList* value = nullptr;
    ~Contacts() { g_slist_free_full(value, g_object_unref); }
};
std::string text(const JSON& input, const char* key) {
    auto value = input.at(key).get<std::string>();
    if (value.size() > 32768 || value.find('\0') != std::string::npos ||
        !g_utf8_validate(value.c_str(), value.size(), nullptr)) throw std::runtime_error("invalid text");
    return value;
}
std::string field(EContact* contact, EContactField key) {
    String value(static_cast<gchar*>(e_contact_get(contact, key)), g_free);
    if (!value) return {};
    const std::string result(value.get());
    if (result.size() > 32768) throw std::runtime_error("field too large");
    return result;
}
JSON list(EContact* contact, EContactField key) {
    auto values = static_cast<GList*>(e_contact_get(contact, key));
    std::unique_ptr<GList, void(*)(GList*)> owned(values, [](GList* v) { g_list_free_full(v, g_free); });
    JSON result = JSON::array();
    for (auto node = values; node; node = node->next) {
        if (result.size() >= 100) throw std::runtime_error("too many values");
        const std::string value(static_cast<const char*>(node->data));
        if (value.size() > 32768) throw std::runtime_error("field too large");
        result.push_back(value);
    }
    return result;
}
JSON card(EContact* contact) {
    return {{"firstName", field(contact, E_CONTACT_GIVEN_NAME)}, {"lastName", field(contact, E_CONTACT_FAMILY_NAME)},
        {"organization", field(contact, E_CONTACT_ORG)}, {"emails", list(contact, E_CONTACT_EMAIL)},
        {"phones", list(contact, E_CONTACT_TEL)}};
}
Object<EBookClient> connect(ESource* source) {
    if (!source) throw std::runtime_error("no source");
    Error error;
    // EDS's documented -1 sentinel avoids waiting for remote authentication.
    // Use the provider's available local/cache state; the parent still bounds IPC.
    Object<EBookClient> client(E_BOOK_CLIENT(e_book_client_connect_sync(source, static_cast<guint32>(-1), nullptr, &error.value)), g_object_unref);
    error.check(client != nullptr);
    return client;
}
JSON search(ESourceRegistry* registry, const JSON& input) {
    const auto query = text(input, "query");
    const int limit = input.at("limit").get<int>();
    if (query.empty() || !input.at("limit").is_number_integer() || input.at("limit") != limit || limit < 1 || limit > 100)
        throw std::runtime_error("invalid query");
    // EBook builds/escapes the expression; user input is never query syntax.
    EBookQuery* terms[] = {e_book_query_field_test(E_CONTACT_FULL_NAME, E_BOOK_QUERY_CONTAINS, query.c_str()),
        e_book_query_field_test(E_CONTACT_ORG, E_BOOK_QUERY_CONTAINS, query.c_str()),
        e_book_query_field_test(E_CONTACT_EMAIL, E_BOOK_QUERY_CONTAINS, query.c_str())};
    auto expression = e_book_query_or(3, terms, TRUE);
    String sexp(e_book_query_to_string(expression), g_free);
    e_book_query_unref(expression);
    Sources sources{e_source_registry_list_enabled(registry, E_SOURCE_EXTENSION_ADDRESS_BOOK)};
    if (g_list_length(sources.value) > 32) throw std::runtime_error("too many sources");
    JSON result = JSON::array();
    for (auto node = sources.value; node && result.size() < static_cast<size_t>(limit); node = node->next) {
        auto client = connect(E_SOURCE(node->data));
        const EContactField fields[] = {E_CONTACT_FAMILY_NAME, E_CONTACT_GIVEN_NAME};
        const EBookCursorSortType sorts[] = {E_BOOK_CURSOR_SORT_ASCENDING, E_BOOK_CURSOR_SORT_ASCENDING};
        EBookClientCursor* raw = nullptr;
        Error error;
        const auto ok = e_book_client_get_cursor_sync(client.get(), sexp.get(), fields, sorts, 2, &raw, nullptr, &error.value);
        Object<EBookClientCursor> cursor(raw, g_object_unref);
        error.check(ok && raw);
        Contacts contacts;
        const auto count = e_book_client_cursor_step_sync(cursor.get(), E_BOOK_CURSOR_STEP_FETCH,
            E_BOOK_CURSOR_ORIGIN_BEGIN, limit - static_cast<int>(result.size()), &contacts.value, nullptr, &error.value);
        error.check(count >= 0);
        for (auto item = contacts.value; item; item = item->next) {
            if (result.size() >= static_cast<size_t>(limit)) throw std::runtime_error("provider exceeded limit");
            result.push_back(card(E_CONTACT(item->data)));
        }
    }
    return result;
}
JSON add(ESourceRegistry* registry, const JSON& input) {
    const auto first = text(input, "firstName"), last = text(input, "lastName"), org = text(input, "organization");
    const auto emails = input.at("emails"), phones = input.at("phones");
    // The shared create tool accepts one email and phone. Validate before any write.
    if (!emails.is_array() || !phones.is_array() || emails.size() > 1 || phones.size() > 1)
        throw std::runtime_error("invalid values");
    const auto email = emails.empty() ? std::string{} : text(JSON{{"value", emails[0]}}, "value");
    const auto phone = phones.empty() ? std::string{} : text(JSON{{"value", phones[0]}}, "value");
    if (first.empty() && last.empty() && org.empty() && email.empty()) throw std::runtime_error("empty contact");
    Object<ESource> source(e_source_registry_ref_default_address_book(registry), g_object_unref);
    auto client = connect(source.get());
    if (e_client_is_readonly(E_CLIENT(client.get()))) throw std::runtime_error("read only");
    Object<EContact> contact(e_contact_new(), g_object_unref);
    const auto full = first.empty() ? last : last.empty() ? first : first + " " + last;
    e_contact_set(contact.get(), E_CONTACT_GIVEN_NAME, first.c_str());
    e_contact_set(contact.get(), E_CONTACT_FAMILY_NAME, last.c_str());
    e_contact_set(contact.get(), E_CONTACT_FULL_NAME, full.c_str());
    e_contact_set(contact.get(), E_CONTACT_ORG, org.c_str());
    if (!email.empty()) e_contact_set(contact.get(), E_CONTACT_EMAIL_1, email.c_str());
    if (!phone.empty()) e_contact_set(contact.get(), E_CONTACT_PHONE_MOBILE, phone.c_str());
    Error error;
    gchar* rawUID = nullptr;
    const auto ok = e_book_client_add_contact_sync(client.get(), contact.get(), E_BOOK_OPERATION_FLAG_NONE, &rawUID, nullptr, &error.value);
    String uid(rawUID, g_free);
    error.check(ok);
    // No retry: a failed transport after a write can have an ambiguous outcome.
    return card(contact.get());
}
Object<ECalClient> calClient(ESource* source, ECalClientSourceType type = E_CAL_CLIENT_SOURCE_TYPE_MEMOS) {
    if (!source) throw std::runtime_error("no memo source");
    Error error;
    Object<ECalClient> client(E_CAL_CLIENT(e_cal_client_connect_sync(source, type,
        static_cast<guint32>(-1), nullptr, &error.value)), g_object_unref);
    error.check(client != nullptr);
    return client;
}
std::string bounded(const char* value) {
    if (!value) return {};
    const std::string result(value);
    if (result.size() > 32768 || !g_utf8_validate(result.c_str(), result.size(), nullptr))
        throw std::runtime_error("invalid provider field");
    return result;
}
JSON memo(ICalComponent* component, const std::string& folder) {
    JSON changed = nullptr;
    Object<ICalProperty> property(i_cal_component_get_first_property(component, I_CAL_LASTMODIFIED_PROPERTY), g_object_unref);
    if (property) {
        Object<ICalTime> time(i_cal_property_get_lastmodified(property.get()), g_object_unref);
        if (time && !i_cal_time_is_null_time(time.get()) && i_cal_time_is_valid_time(time.get()))
            changed = static_cast<int64_t>(i_cal_time_as_timet(time.get())) * 1000;
    }
    std::string body;
    for (auto raw = i_cal_component_get_first_property(component, I_CAL_DESCRIPTION_PROPERTY); raw;
         raw = i_cal_component_get_next_property(component, I_CAL_DESCRIPTION_PROPERTY)) {
        Object<ICalProperty> description(raw, g_object_unref);
        if (!body.empty()) body += '\n';
        body += bounded(i_cal_property_get_description(description.get()));
        if (body.size() > 32768) throw std::runtime_error("memo too large");
    }
    return {{"title", bounded(i_cal_component_get_summary(component))}, {"folder", folder},
        {"changed", changed}, {"text", body}};
}
struct MemoView {
    GMainLoop* loop;
    JSON& rows;
    size_t& bytes;
    std::function<JSON(ICalComponent*)> convert;
    bool done = false;
    bool failed = false;
    bool changed = false;
    void stop(bool failure) { failed = failed || failure; done = true; g_main_loop_quit(loop); }
};
// A source changed while it was read. EDS can also tell a new view of a change saved before the
// view started (a write of ours just before the read included), so a read refused this way is made
// again (`run`).
struct SourceChanged : std::runtime_error { SourceChanged() : std::runtime_error("source changed during read") {} };
using CalConvert = std::function<JSON(ICalComponent*, ECalClient*, const std::string&)>;
JSON readCal(ESourceRegistry* registry, const std::string& sexp, const char* extension,
    ECalClientSourceType type, const std::vector<const char*>& requestedFields, CalConvert convert,
    std::function<void(ECalClient*, const std::string&)> finish = {}) {
    Sources sources{e_source_registry_list_enabled(registry, extension)};
    if (g_list_length(sources.value) > 32) throw std::runtime_error("too many sources");
    JSON rows = JSON::array();
    size_t bytes = 0;
    for (auto node = sources.value; node; node = node->next) {
        const auto source = E_SOURCE(node->data);
        auto client = calClient(source, type);
        Error error;
        ECalClientView* raw = nullptr;
        const auto ok = e_cal_client_get_view_sync(client.get(), sexp.c_str(), &raw, nullptr, &error.value);
        Object<ECalClientView> view(raw, g_object_unref);
        error.check(ok && raw);
        // Fields are a provider hint, not a security boundary. Accumulation is bounded below.
        GSList* fields = nullptr;
        for (const auto key : requestedFields) fields = g_slist_prepend(fields, const_cast<char*>(key));
        e_cal_client_view_set_fields_of_interest(view.get(), fields, &error.value);
        g_slist_free(fields);
        error.check();
        std::unique_ptr<GMainLoop, decltype(&g_main_loop_unref)> loop(g_main_loop_new(nullptr, FALSE), g_main_loop_unref);
        MemoView state{loop.get(), rows, bytes, [&](ICalComponent* component) { return convert(component, client.get(), bounded(e_source_get_display_name(source))); }};
        g_signal_connect(view.get(), "objects-added", G_CALLBACK(+[](ECalClientView*, const GSList* objects, gpointer data) {
            auto& state = *static_cast<MemoView*>(data);
            if (state.done) return;
            try {
                for (auto item = objects; item; item = item->next) {
                    if (state.rows.size() >= 1000) throw std::runtime_error("too many matches");
                    auto row = state.convert(I_CAL_COMPONENT(item->data));
                    if (row.is_null()) continue;
                    state.bytes += row.dump().size();
                    if (state.bytes > 512 * 1024) throw std::runtime_error("too much text");
                    state.rows.push_back(std::move(row));
                }
            } catch (...) { state.stop(true); }
        }), &state);
        g_signal_connect(view.get(), "complete", G_CALLBACK(+[](ECalClientView*, const GError* error, gpointer data) {
            static_cast<MemoView*>(data)->stop(error != nullptr);
        }), &state);
        // A changing snapshot is refused rather than mixing old and new versions.
        for (const auto signal : {"objects-modified", "objects-removed"})
            g_signal_connect(view.get(), signal, G_CALLBACK(+[](ECalClientView*, const GSList*, gpointer data) {
                auto& state = *static_cast<MemoView*>(data);
                state.changed = true;
                state.stop(true);
            }), &state);
        const auto timer = g_timeout_add_seconds(10, +[](gpointer data) -> gboolean {
            static_cast<MemoView*>(data)->stop(true); return G_SOURCE_CONTINUE;
        }, &state);
        e_cal_client_view_start(view.get(), &error.value);
        if (!error.value && !state.done) g_main_loop_run(loop.get());
        g_source_remove(timer);
        g_signal_handlers_disconnect_by_data(view.get(), &state);
        Error stopError;
        e_cal_client_view_stop(view.get(), &stopError.value);
        if (state.changed) throw SourceChanged();
        error.check(!state.failed);
        stopError.check();
        if (finish) finish(client.get(), bounded(e_source_get_display_name(source)));
    }
    return rows;
}
JSON notesSearch(ESourceRegistry* registry, const JSON& input) {
    const auto query = text(input, "query");
    if (query.empty()) throw std::runtime_error("empty query");
    auto encoded = g_string_new(nullptr);
    e_sexp_encode_string(encoded, query.c_str());
    const std::string sexp = "(or (contains? \"summary\" " + std::string(encoded->str) +
        ") (contains? \"description\" " + encoded->str + "))";
    g_string_free(encoded, TRUE);
    return readCal(registry, sexp, E_SOURCE_EXTENSION_MEMO_LIST, E_CAL_CLIENT_SOURCE_TYPE_MEMOS,
        {"SUMMARY", "DESCRIPTION", "LAST-MODIFIED"}, [](ICalComponent* component, ECalClient*, const std::string& folder) {
            return memo(component, folder);
        });
}
JSON notesAdd(ESourceRegistry* registry, const JSON& input) {
    const auto title = text(input, "title"), body = text(input, "text");
    if (title.empty() || body.empty()) throw std::runtime_error("empty memo");
    Object<ESource> source(e_source_registry_ref_default_memo_list(registry), g_object_unref);
    auto client = calClient(source.get());
    if (e_client_is_readonly(E_CLIENT(client.get()))) throw std::runtime_error("read only");
    Object<ICalComponent> component(i_cal_component_new_vjournal(), g_object_unref);
    String uid(g_uuid_string_random(), g_free);
    i_cal_component_set_uid(component.get(), uid.get());
    i_cal_component_set_summary(component.get(), title.c_str());
    i_cal_component_set_description(component.get(), body.c_str());
    Object<ICalTime> now(i_cal_time_new_current_with_zone(i_cal_timezone_get_utc_timezone()), g_object_unref);
    i_cal_component_set_dtstamp(component.get(), now.get());
    Error error;
    gchar* rawUID = nullptr;
    const auto ok = e_cal_client_create_object_sync(client.get(), component.get(), E_CAL_OPERATION_FLAG_NONE, &rawUID, nullptr, &error.value);
    String savedUID(rawUID, g_free);
    error.check(ok);
    return {{"title", title}, {"folder", bounded(e_source_get_display_name(source.get()))}};
}

int64_t milliseconds(const JSON& value) {
    if (!value.is_number_integer()) throw std::runtime_error("invalid time");
    const auto result = value.get<int64_t>();
    if (value != result || result < -2208988800000LL || result > 253402300799000LL)
        throw std::runtime_error("time outside supported range");
    return result;
}
JSON optionalText(const JSON& input, const char* key) {
    return input.at(key).is_null() ? JSON(nullptr) : JSON(text(input, key));
}
Object<ICalTime> dateFromWire(int64_t value, bool hasTime) {
    if (hasTime) return Object<ICalTime>(i_cal_time_new_from_timet_with_zone(value / 1000, FALSE, i_cal_timezone_get_utc_timezone()), g_object_unref);
    std::unique_ptr<GDateTime, decltype(&g_date_time_unref)> local(g_date_time_new_from_unix_local(value / 1000), g_date_time_unref);
    if (!local) throw std::runtime_error("invalid date");
    String encoded(g_date_time_format(local.get(), "%Y%m%d"), g_free);
    return Object<ICalTime>(i_cal_time_new_from_string(encoded.get()), g_object_unref);
}
int64_t dateToWire(ICalTime* value, ICalProperty* property, ECalClient* client) {
    if (!value || i_cal_time_is_null_time(value) || !i_cal_time_is_valid_time(value)) throw std::runtime_error("invalid provider date");
    if (i_cal_time_is_utc(value)) return static_cast<int64_t>(i_cal_time_as_timet(value)) * 1000;
    Object<ICalParameter> parameter(property ? i_cal_property_get_first_parameter(property, I_CAL_TZID_PARAMETER) : nullptr, g_object_unref);
    if (parameter && !i_cal_time_is_date(value)) {
        const auto tzid = bounded(i_cal_parameter_get_tzid(parameter.get()));
        ICalTimezone* zone = nullptr;
        Error error;
        error.check(e_cal_client_get_timezone_sync(client, tzid.c_str(), &zone, nullptr, &error.value) && zone);
        return static_cast<int64_t>(i_cal_time_as_timet_with_zone(value, zone)) * 1000;
    }
    // DATE and floating times are local, matching EventKit's due-date contract.
    const bool dateOnly = i_cal_time_is_date(value);
    std::unique_ptr<GDateTime, decltype(&g_date_time_unref)> local(g_date_time_new_local(
        i_cal_time_get_year(value), i_cal_time_get_month(value), i_cal_time_get_day(value),
        dateOnly ? 0 : i_cal_time_get_hour(value), dateOnly ? 0 : i_cal_time_get_minute(value),
        dateOnly ? 0 : i_cal_time_get_second(value)), g_date_time_unref);
    if (!local) throw std::runtime_error("invalid local date");
    return g_date_time_to_unix(local.get()) * 1000;
}
JSON reminder(ICalComponent* component, ECalClient* client, const std::string& folder) {
    JSON due = nullptr;
    bool hasTime = false;
    Object<ICalProperty> property(i_cal_component_get_first_property(component, I_CAL_DUE_PROPERTY), g_object_unref);
    if (property) {
        Object<ICalTime> date(i_cal_property_get_due(property.get()), g_object_unref);
        due = dateToWire(date.get(), property.get(), client);
        hasTime = !i_cal_time_is_date(date.get());
    }
    const auto body = memo(component, folder).at("text").get<std::string>();
    return {{"title", bounded(i_cal_component_get_summary(component))}, {"list", folder},
        {"due", due}, {"dueHasTime", hasTime}, {"notes", body.empty() ? JSON(nullptr) : JSON(body)}};
}
JSON reminders(ESourceRegistry* registry, const JSON& input) {
    const JSON before = input.at("dueBefore").is_null() ? JSON(nullptr) : JSON(milliseconds(input.at("dueBefore")));
    return readCal(registry, "(not (is-completed?))", E_SOURCE_EXTENSION_TASK_LIST, E_CAL_CLIENT_SOURCE_TYPE_TASKS,
        {"SUMMARY", "DESCRIPTION", "DUE", "STATUS", "COMPLETED", "PERCENT-COMPLETE"},
        [&](ICalComponent* component, ECalClient* client, const std::string& folder) -> JSON {
            if (i_cal_component_get_status(component) == I_CAL_STATUS_COMPLETED || i_cal_component_get_status(component) == I_CAL_STATUS_CANCELLED)
                return nullptr;
            auto row = reminder(component, client, folder);
            if (!before.is_null() && (row["due"].is_null() || row["due"] >= before)) return nullptr;
            return row;
        });
}
JSON reminderAdd(ESourceRegistry* registry, const JSON& input) {
    const auto title = text(input, "title");
    if (title.empty() || !input.at("dueHasTime").is_boolean()) throw std::runtime_error("invalid reminder");
    const bool hasTime = input.at("dueHasTime").get<bool>();
    const auto notes = optionalText(input, "notes");
    const JSON due = input.at("due").is_null() ? JSON(nullptr) : JSON(milliseconds(input.at("due")));
    if (due.is_null() && hasTime) throw std::runtime_error("missing due date");
    Object<ESource> source(e_source_registry_ref_default_task_list(registry), g_object_unref);
    auto client = calClient(source.get(), E_CAL_CLIENT_SOURCE_TYPE_TASKS);
    if (e_client_is_readonly(E_CLIENT(client.get()))) throw std::runtime_error("read only");
    Object<ICalComponent> component(i_cal_component_new_vtodo(), g_object_unref);
    String uid(g_uuid_string_random(), g_free);
    i_cal_component_set_uid(component.get(), uid.get());
    i_cal_component_set_summary(component.get(), title.c_str());
    if (!notes.is_null()) i_cal_component_set_description(component.get(), notes.get<std::string>().c_str());
    if (!due.is_null()) {
        auto date = dateFromWire(due.get<int64_t>(), hasTime);
        // EventKit stores reminder due dates at minute precision.
        if (hasTime) i_cal_time_set_second(date.get(), 0);
        i_cal_component_set_due(component.get(), date.get());
    }
    Object<ICalTime> now(i_cal_time_new_current_with_zone(i_cal_timezone_get_utc_timezone()), g_object_unref);
    i_cal_component_set_dtstamp(component.get(), now.get());
    // Construct the response before writing, so invalid provider values cannot
    // turn a successful write into an avoidable post-write failure.
    auto result = reminder(component.get(), client.get(), bounded(e_source_get_display_name(source.get())));
    Error error;
    gchar* rawUID = nullptr;
    const auto ok = e_cal_client_create_object_sync(client.get(), component.get(), E_CAL_OPERATION_FLAG_NONE, &rawUID, nullptr, &error.value);
    String savedUID(rawUID, g_free);
    error.check(ok);
    return result;
}

JSON calendarEvent(ICalComponent* component, ECalClient* client, const std::string& calendar) {
    Object<ICalProperty> startProperty(i_cal_component_get_first_property(component, I_CAL_DTSTART_PROPERTY), g_object_unref);
    Object<ICalTime> start(i_cal_component_get_dtstart(component), g_object_unref);
    Object<ICalProperty> endProperty(i_cal_component_get_first_property(component, I_CAL_DTEND_PROPERTY), g_object_unref);
    Object<ICalTime> end(i_cal_component_get_dtend(component), g_object_unref);
    if (!start || i_cal_time_is_null_time(start.get())) throw std::runtime_error("event has no start");
    const bool allDay = i_cal_time_is_date(start.get());
    if (!end || i_cal_time_is_null_time(end.get())) {
        end.reset(i_cal_time_clone(start.get()));
        if (allDay) i_cal_time_adjust(end.get(), 1, 0, 0, 0);
    }
    const auto startMs = dateToWire(start.get(), startProperty.get(), client);
    const auto endMs = dateToWire(end.get(), endProperty.get(), client);
    if (endMs < startMs) throw std::runtime_error("event ends before start");
    // EDS stores all-day DTEND exclusively; the shared tools describe the last day.
    if (allDay) i_cal_time_adjust(end.get(), -1, 0, 0, 0);
    const auto body = memo(component, calendar).at("text").get<std::string>();
    const auto location = bounded(i_cal_component_get_location(component));
    return {{"title", bounded(i_cal_component_get_summary(component))}, {"calendar", calendar},
        {"start", startMs}, {"end", allDay ? dateToWire(end.get(), endProperty.get(), client) : endMs},
        {"isAllDay", allDay}, {"location", location.empty() ? JSON(nullptr) : JSON(location)},
        {"notes", body.empty() ? JSON(nullptr) : JSON(body)}};
}

// Calendar adapters resolve zones through the same EDS provider as the series.
Object<ICalTime> calendarTime(ICalComponent* component, ICalPropertyKind kind, ECalClient* client, ICalTimezone* local) {
    Object<ICalTime> value(kind == I_CAL_DTSTART_PROPERTY ? i_cal_component_get_dtstart(component) : i_cal_component_get_dtend(component), g_object_unref);
    if (!value || i_cal_time_is_null_time(value.get()) || !i_cal_time_is_valid_time(value.get())) throw std::runtime_error("invalid calendar time");
    Object<ICalProperty> property(i_cal_component_get_first_property(component, kind), g_object_unref);
    if (!property && kind == I_CAL_DTEND_PROPERTY) property.reset(i_cal_component_get_first_property(component, I_CAL_DTSTART_PROPERTY));
    Object<ICalParameter> parameter(property ? i_cal_property_get_first_parameter(property.get(), I_CAL_TZID_PARAMETER) : nullptr, g_object_unref);
    auto zone = i_cal_time_is_utc(value.get()) ? i_cal_timezone_get_utc_timezone() : local;
    if (parameter && !i_cal_time_is_date(value.get())) {
        Error error;
        error.check(e_cal_client_get_timezone_sync(client, i_cal_parameter_get_tzid(parameter.get()), &zone, nullptr, &error.value) && zone);
    }
    i_cal_time_set_timezone(value.get(), zone);
    return value;
}
int64_t instant(ICalTime* value, ICalTimezone* local) {
    return static_cast<int64_t>(i_cal_time_as_timet_with_zone(value, i_cal_time_get_timezone(value) ? i_cal_time_get_timezone(value) : local)) * 1000;
}
int64_t wallSeconds(ICalTime* value) {
    Object<ICalTime> wall(i_cal_time_clone(value), g_object_unref);
    i_cal_time_set_timezone(wall.get(), i_cal_timezone_get_utc_timezone());
    return static_cast<int64_t>(i_cal_time_as_timet(wall.get()));
}
void shiftWall(ICalTime* value, int64_t seconds) {
    i_cal_time_adjust(value, static_cast<int>(seconds / 86400), 0, 0, static_cast<int>(seconds % 86400));
}
struct CalendarRange {
    int64_t rid, shift, duration;
    bool prior, allDay;
    ICalComponent* component;
    ICalTimezone* zone;
};
ICalTimezone* localZone() {
    String location(e_cal_util_get_system_timezone_location(), g_free);
    auto zone = location ? i_cal_timezone_get_builtin_timezone(location.get()) : nullptr;
    if (!zone) throw std::runtime_error("no local timezone");
    return zone;
}
void removeAll(ICalComponent* component, ICalPropertyKind kind) {
    while (auto raw = i_cal_component_get_first_property(component, kind)) {
        Object<ICalProperty> owned(raw, g_object_unref);
        i_cal_component_remove_property(component, raw);
    }
}
// Replaces `component`'s dates, and their stale TZID parameters, with `start` and `end` as
// instants in UTC (DATE values remain DATE for the shared all-day contract). DTEND cannot
// coexist with DURATION.
void replaceTimes(ICalComponent* component, ICalTime* start, ICalTime* end, ICalTimezone* local) {
    for (const auto kind : {I_CAL_DTSTART_PROPERTY, I_CAL_DTEND_PROPERTY, I_CAL_DURATION_PROPERTY}) removeAll(component, kind);
    auto normalized = [&](ICalTime* value) {
        if (i_cal_time_is_date(value)) return Object<ICalTime>(i_cal_time_clone(value), g_object_unref);
        const auto seconds = i_cal_time_as_timet_with_zone(value, i_cal_time_get_timezone(value) ? i_cal_time_get_timezone(value) : local);
        return Object<ICalTime>(i_cal_time_new_from_timet_with_zone(seconds, FALSE, i_cal_timezone_get_utc_timezone()), g_object_unref);
    };
    i_cal_component_set_dtstart(component, normalized(start).get());
    i_cal_component_set_dtend(component, normalized(end).get());
}
// A stored event as an occurrence row shows it: its times resolved through the provider's zones.
Object<ICalComponent> shown(ICalComponent* stored, ECalClient* client, ICalTimezone* local) {
    Object<ICalComponent> result(i_cal_component_clone(stored), g_object_unref);
    auto start = calendarTime(stored, I_CAL_DTSTART_PROPERTY, client, local);
    Object<ICalTime> end(nullptr, g_object_unref);
    if (i_cal_component_count_properties(stored, I_CAL_DTEND_PROPERTY) || i_cal_component_count_properties(stored, I_CAL_DURATION_PROPERTY)) {
        end = calendarTime(stored, I_CAL_DTEND_PROPERTY, client, local);
    } else {
        end.reset(i_cal_time_clone(start.get()));
        if (i_cal_time_is_date(start.get())) i_cal_time_adjust(end.get(), 1, 0, 0, 0);
    }
    replaceTimes(result.get(), start.get(), end.get(), local);
    return result;
}

// Why an event request can't be carried out, by the name the macOS helper gives it: the app
// tells the user what each means. Answered as `{"refused": kind}`, never as a failure.
struct Refusal { std::string kind; };
[[noreturn]] void refuse(const char* kind) { throw Refusal{kind}; }

std::string lowered(std::string value) {
    for (auto& character : value) character = static_cast<char>(g_ascii_tolower(character));
    return value;
}
// The email a calendar user address names ("mailto:…"), or "" for one that names none.
std::string address(const char* value) {
    auto result = bounded(value);
    if (g_ascii_strncasecmp(result.c_str(), "mailto:", 7) == 0) result = result.substr(7);
    else if (result.find(':') != std::string::npos) return {};
    return result.find('@') == std::string::npos ? std::string{} : result;
}

// An event's id: its calendar's source and its uid, and for an occurrence changed on its own the
// RECURRENCE-ID EDS keeps it by. `|` separates them; `%` and `|` inside one are escaped.
std::string escaped(const std::string& value) {
    std::string result;
    for (const char character : value) result += character == '%' ? std::string("%25") : character == '|' ? std::string("%7C") : std::string(1, character);
    return result;
}
std::string unescaped(const std::string& value) {
    std::string result;
    for (size_t index = 0; index < value.size(); ++index) {
        if (value[index] != '%') { result += value[index]; continue; }
        const auto code = value.substr(index + 1, 2);
        if (code == "25") result += '%';
        else if (code == "7C") result += '|';
        else refuse("noSuchEvent");
        index += 2;
    }
    return result;
}
std::string eventID(const std::string& source, const std::string& uid, const std::string& rid = {}) {
    return escaped(source) + "|" + escaped(uid) + (rid.empty() ? std::string{} : "|" + escaped(rid));
}
struct EventID { std::string source, uid, rid; };
EventID parseEventID(const std::string& id) {
    std::vector<std::string> parts(1);
    for (const char character : id) {
        if (character == '|') parts.emplace_back();
        else parts.back() += character;
    }
    if (parts.size() < 2 || parts.size() > 3) refuse("noSuchEvent");
    EventID result{unescaped(parts[0]), unescaped(parts[1]), parts.size() == 3 ? unescaped(parts[2]) : std::string{}};
    if (result.source.empty() || result.uid.empty() || (parts.size() == 3 && result.rid.empty())) refuse("noSuchEvent");
    return result;
}
std::string recurrenceIDText(ICalComponent* component) {
    String value(e_cal_util_component_get_recurid_as_string(component), g_free);
    return value ? bounded(value.get()) : std::string{};
}
bool repeating(ICalComponent* component) {
    return i_cal_component_count_properties(component, I_CAL_RRULE_PROPERTY) || i_cal_component_count_properties(component, I_CAL_RDATE_PROPERTY);
}

struct Calendar {
    std::string id, title;
    // The user's address on the calendar's server, lowercased: "" for a calendar on this computer.
    std::string own;
};
Calendar calendarOf(ECalClient* client) {
    const auto source = e_client_get_source(E_CLIENT(client));
    gchar* raw = nullptr;
    Error error;
    const auto ok = e_client_get_backend_property_sync(E_CLIENT(client), E_CAL_BACKEND_PROPERTY_CAL_EMAIL_ADDRESS, &raw, nullptr, &error.value);
    String own(raw, g_free);
    error.check(ok);
    return {bounded(e_source_get_uid(source)), bounded(e_source_get_display_name(source)), lowered(address(own.get()))};
}

// Someone invited to an event, or its organizer; null for one without an email.
JSON person(ICalProperty* property, bool organizer) {
    const auto email = address(organizer ? i_cal_property_get_organizer(property) : i_cal_property_get_attendee(property));
    if (email.empty()) return nullptr;
    Object<ICalParameter> cn(i_cal_property_get_first_parameter(property, I_CAL_CN_PARAMETER), g_object_unref);
    const auto name = cn ? bounded(i_cal_parameter_get_cn(cn.get())) : std::string{};
    std::string status = "unknown";
    if (!organizer) {
        Object<ICalParameter> partstat(i_cal_property_get_first_parameter(property, I_CAL_PARTSTAT_PARAMETER), g_object_unref);
        // RFC 5545: an attendee without one has not answered yet.
        const auto value = partstat ? i_cal_parameter_get_partstat(partstat.get()) : I_CAL_PARTSTAT_NEEDSACTION;
        status = value == I_CAL_PARTSTAT_ACCEPTED ? "accepted" : value == I_CAL_PARTSTAT_DECLINED ? "declined"
            : value == I_CAL_PARTSTAT_TENTATIVE ? "tentative" : value == I_CAL_PARTSTAT_NEEDSACTION ? "pending" : "unknown";
    }
    return {{"email", email}, {"name", name.empty() ? JSON(nullptr) : JSON(name)}, {"status", status}};
}

int64_t whole(const std::string& value, int64_t low, int64_t high) {
    gint64 result = 0;
    if (!g_ascii_string_to_signed(value.c_str(), 10, low, high, &result, nullptr)) throw std::runtime_error("invalid rule number");
    return result;
}
const char* const weekdayCodes[] = {"SU", "MO", "TU", "WE", "TH", "FR", "SA"};
// The event's rule as the app reads it (the macOS helper's fields); null for one the app can't
// say: by the hour or finer, or by time of day.
JSON recurrence(ICalComponent* component, ECalClient* client) {
    Object<ICalProperty> property(i_cal_component_get_first_property(component, I_CAL_RRULE_PROPERTY), g_object_unref);
    if (!property) return nullptr;
    Object<ICalRecurrence> rule(i_cal_property_get_rrule(property.get()), g_object_unref);
    String encoded(rule ? i_cal_recurrence_to_string(rule.get()) : nullptr, g_free);
    if (!encoded) throw std::runtime_error("invalid rule");
    JSON result = {{"interval", 1}, {"count", nullptr}, {"until", nullptr}, {"days", JSON::array()}, {"monthDays", JSON::array()},
        {"months", JSON::array()}, {"positions", JSON::array()}, {"yearWeeks", JSON::array()}, {"yearDays", JSON::array()}};
    const std::map<std::string, std::pair<const char*, int64_t>> lists{{"BYMONTHDAY", {"monthDays", 31}}, {"BYMONTH", {"months", 12}},
        {"BYSETPOS", {"positions", 366}}, {"BYWEEKNO", {"yearWeeks", 53}}, {"BYYEARDAY", {"yearDays", 366}}};
    const auto parts = std::unique_ptr<gchar*, decltype(&g_strfreev)>(g_strsplit(bounded(encoded.get()).c_str(), ";", -1), g_strfreev);
    for (auto part = parts.get(); *part; ++part) {
        const std::string text(*part);
        const auto equals = text.find('=');
        if (equals == std::string::npos) return nullptr;
        const auto key = text.substr(0, equals), value = text.substr(equals + 1);
        const auto items = std::unique_ptr<gchar*, decltype(&g_strfreev)>(g_strsplit(value.c_str(), ",", -1), g_strfreev);
        if (key == "FREQ") {
            if (value != "DAILY" && value != "WEEKLY" && value != "MONTHLY" && value != "YEARLY") return nullptr;
            result["frequency"] = value;
        } else if (key == "INTERVAL") {
            result["interval"] = whole(value, 1, G_MAXINT32);
        } else if (key == "COUNT") {
            result["count"] = whole(value, 1, G_MAXINT32);
        } else if (key == "UNTIL") {
            Object<ICalTime> until(i_cal_time_new_from_string(value.c_str()), g_object_unref);
            if (!until || i_cal_time_is_null_time(until.get()) || !i_cal_time_is_valid_time(until.get())) throw std::runtime_error("invalid rule end");
            if (!i_cal_time_is_date(until.get())) result["until"] = dateToWire(until.get(), nullptr, client);
            else {
                // A day repeats through its end, as the app writes one.
                i_cal_time_adjust(until.get(), 1, 0, 0, 0);
                result["until"] = dateToWire(until.get(), nullptr, client) - 1;
            }
        } else if (key == "BYDAY") {
            for (auto item = items.get(); *item; ++item) {
                const std::string day(*item);
                if (day.size() < 2) throw std::runtime_error("invalid rule day");
                const auto code = day.substr(day.size() - 2);
                const auto found = std::find_if(std::begin(weekdayCodes), std::end(weekdayCodes), [&](const char* candidate) { return code == candidate; });
                if (found == std::end(weekdayCodes)) throw std::runtime_error("invalid rule day");
                const auto week = day.size() == 2 ? 0 : whole(day.substr(0, day.size() - 2), -53, 53);
                result["days"].push_back({{"weekday", found - std::begin(weekdayCodes) + 1}, {"week", week}});
            }
        } else if (lists.contains(key)) {
            const auto& [name, limit] = lists.at(key);
            for (auto item = items.get(); *item; ++item) result[name].push_back(whole(*item, key == "BYMONTH" ? 1 : -limit, limit));
        } else if (key != "WKST") {
            return nullptr;
        }
    }
    return result.contains("frequency") ? result : JSON(nullptr);
}

// The zone an event's times and its rule's days are counted in, by its IANA name; null for one
// all day or floating, or in a zone without such a name.
JSON zoneName(ICalComponent* component, ECalClient* client) {
    Object<ICalTime> start(i_cal_component_get_dtstart(component), g_object_unref);
    if (!start || i_cal_time_is_null_time(start.get()) || i_cal_time_is_date(start.get())) return nullptr;
    if (i_cal_time_is_utc(start.get())) return "UTC";
    Object<ICalProperty> property(i_cal_component_get_first_property(component, I_CAL_DTSTART_PROPERTY), g_object_unref);
    Object<ICalParameter> parameter(property ? i_cal_property_get_first_parameter(property.get(), I_CAL_TZID_PARAMETER) : nullptr, g_object_unref);
    if (!parameter) return nullptr;
    ICalTimezone* zone = nullptr;
    Error error;
    error.check(e_cal_client_get_timezone_sync(client, i_cal_parameter_get_tzid(parameter.get()), &zone, nullptr, &error.value) && zone);
    const auto location = i_cal_timezone_get_location(zone);
    if (!location || !i_cal_timezone_get_builtin_timezone(location)) return nullptr;
    return bounded(location);
}

// A row as the calendar tools read it: `shownComponent`'s times and people, `stored`'s zone and
// `master`'s rule (an occurrence changed on its own keeps its series').
JSON eventRow(ICalComponent* shownComponent, ICalComponent* stored, ICalComponent* master, ECalClient* client, const Calendar& calendar,
    JSON id, JSON occurrence, bool detached) {
    auto row = calendarEvent(shownComponent, client, calendar.title);
    Object<ICalProperty> transparency(i_cal_component_get_first_property(shownComponent, I_CAL_TRANSP_PROPERTY), g_object_unref);
    const auto transparent = transparency && (i_cal_property_get_transp(transparency.get()) == I_CAL_TRANSP_TRANSPARENT ||
        i_cal_property_get_transp(transparency.get()) == I_CAL_TRANSP_TRANSPARENTNOCONFLICT);
    JSON attendees = JSON::array();
    for (auto raw = i_cal_component_get_first_property(shownComponent, I_CAL_ATTENDEE_PROPERTY); raw;
         raw = i_cal_component_get_next_property(shownComponent, I_CAL_ATTENDEE_PROPERTY)) {
        Object<ICalProperty> property(raw, g_object_unref);
        auto attendee = person(property.get(), false);
        if (!attendee.is_null()) attendees.push_back(std::move(attendee));
    }
    Object<ICalProperty> organizerProperty(i_cal_component_get_first_property(shownComponent, I_CAL_ORGANIZER_PROPERTY), g_object_unref);
    const auto organizer = organizerProperty ? person(organizerProperty.get(), true) : JSON(nullptr);
    row["id"] = std::move(id);
    row["occurrence"] = std::move(occurrence);
    row["calendarId"] = calendar.id;
    row["availability"] = transparent ? "free" : "busy";
    // Invited by someone else, whose server overwrites the user's copy: theirs to change.
    row["isInvitation"] = !attendees.empty() && !organizer.is_null() && lowered(organizer["email"].get<std::string>()) != calendar.own;
    row["attendees"] = std::move(attendees);
    row["organizer"] = organizer;
    row["recurrence"] = master ? recurrence(master, client) : JSON(nullptr);
    row["isDetached"] = detached;
    row["timeZone"] = zoneName(stored, client);
    return row;
}

// Expand only a successfully completed snapshot, using EDS's error-returning recurrence engine
// rather than the void client convenience wrappers. `components` is every component of each
// series in it, fetched through the UID API: a moved-out override must still suppress its
// original occurrence.
void expand(const std::vector<Object<ICalComponent>>& components, ECalClient* client, const Calendar& calendar, ICalTimezone* zone,
    int64_t from, int64_t to, JSON& result, size_t& outputBytes) {
    std::map<std::string, std::set<int64_t>> overrides;
    std::map<std::string, std::vector<CalendarRange>> ranges;
    std::map<std::string, ICalComponent*> masters;
    for (const auto& component : components) {
        Object<ICalProperty> rid(i_cal_component_get_first_property(component.get(), I_CAL_RECURRENCEID_PROPERTY), g_object_unref);
        const auto uid = bounded(i_cal_component_get_uid(component.get()));
        if (!rid) { masters.emplace(uid, component.get()); continue; }
        Object<ICalParameter> range(i_cal_property_get_first_parameter(rid.get(), I_CAL_RANGE_PARAMETER), g_object_unref);
        Object<ICalTime> date(i_cal_property_get_recurrenceid(rid.get()), g_object_unref);
        const auto identity = dateToWire(date.get(), rid.get(), client);
        overrides[uid].insert(identity);
        if (range) {
            const auto direction = i_cal_parameter_get_range(range.get());
            if (direction != I_CAL_RANGE_THISANDFUTURE && direction != I_CAL_RANGE_THISANDPRIOR)
                throw std::runtime_error("invalid recurrence range");
            auto start = calendarTime(component.get(), I_CAL_DTSTART_PROPERTY, client, zone);
            auto end = calendarTime(component.get(), I_CAL_DTEND_PROPERTY, client, zone);
            const bool allDay = i_cal_time_is_date(start.get());
            if (allDay != static_cast<bool>(i_cal_time_is_date(date.get())) || allDay != static_cast<bool>(i_cal_time_is_date(end.get())))
                throw std::runtime_error("inconsistent range date type");
            const auto duration = allDay ? (wallSeconds(end.get()) - wallSeconds(start.get())) * 1000 : instant(end.get(), zone) - instant(start.get(), zone);
            if (duration < 0) throw std::runtime_error("negative event duration");
            ranges[uid].push_back({identity, wallSeconds(start.get()) - wallSeconds(date.get()), duration,
                direction == I_CAL_RANGE_THISANDPRIOR, allDay, component.get(), i_cal_time_get_timezone(start.get())});
        }
    }
    for (const auto& component : components) {
        Object<ICalProperty> rid(i_cal_component_get_first_property(component.get(), I_CAL_RECURRENCEID_PROPERTY), g_object_unref);
        if (i_cal_component_get_status(component.get()) == I_CAL_STATUS_CANCELLED) continue;
        // Resolve provider zones explicitly: recurrence APIs may fall back
        // to a default zone when a referenced timezone is unavailable.
        calendarTime(component.get(), I_CAL_DTSTART_PROPERTY, client, zone);
        calendarTime(component.get(), I_CAL_DTEND_PROPERTY, client, zone);
        const auto uid = bounded(i_cal_component_get_uid(component.get()));
        JSON detachedFrom = nullptr;
        if (rid) {
            Object<ICalTime> date(i_cal_property_get_recurrenceid(rid.get()), g_object_unref);
            detachedFrom = dateToWire(date.get(), rid.get(), client);
        }
        const auto master = masters.contains(uid) ? masters.at(uid) : nullptr;
        struct Expansion {
            ECalClient* client;
            const Calendar& calendar;
            JSON& result;
            size_t& bytes;
            const std::set<int64_t>* overrides;
            const std::vector<CalendarRange>* ranges;
            ICalTimezone* zone;
            int64_t from, to;
            ICalComponent* stored;
            ICalComponent* master;
            std::string id;
            // Of an occurrence changed on its own, its original start; else null.
            JSON detachedFrom;
            bool series;
            size_t visited = 0;
            bool failed = false;
        } state{client, calendar, result, outputBytes,
            rid ? nullptr : &overrides[uid], rid ? nullptr : &ranges[uid], zone, from, to, component.get(), master,
            rid ? eventID(calendar.id, uid, recurrenceIDText(component.get())) : eventID(calendar.id, uid), detachedFrom,
            !rid && repeating(component.get())};
        int64_t lower = from, upper = to;
        if (state.ranges) for (const auto& change : *state.ranges) {
            // Inverse-shift the request, including changed durations and
            // timezone-offset transitions. Final overlap is checked below.
            lower = std::min(lower, from - change.shift * 1000 - change.duration - 2 * 86400000);
            upper = std::max(upper, to - change.shift * 1000 + 2 * 86400000);
        }
        auto expansionStart = dateFromWire(std::max<int64_t>(lower, -2208988800000LL), true);
        auto expansionEnd = dateFromWire(std::min<int64_t>(upper, 253402300799000LL), true);
        Error error;
        const auto success = e_cal_recur_generate_instances_sync(component.get(), expansionStart.get(), expansionEnd.get(),
            +[](ICalComponent* original, ICalTime* start, ICalTime* end, gpointer data, GCancellable*, GError**) -> gboolean {
                auto& state = *static_cast<Expansion*>(data);
                try {
                    if (++state.visited > 10000) throw std::runtime_error("too many generated occurrences");
                    const auto identity = instant(start, state.zone);
                    if (state.overrides && state.overrides->contains(identity)) return TRUE;
                    const CalendarRange* selected = nullptr;
                    if (state.ranges) for (const auto& change : *state.ranges) {
                        if (!change.prior && change.rid <= identity && (!selected || selected->prior || selected->rid < change.rid)) selected = &change;
                        if (change.prior && change.rid >= identity && (!selected || (selected->prior && selected->rid > change.rid))) selected = &change;
                    }
                    Object<ICalTime> shiftedStart(i_cal_time_clone(start), g_object_unref), shiftedEnd(i_cal_time_clone(end), g_object_unref);
                    if (selected) {
                        if (i_cal_component_get_status(selected->component) == I_CAL_STATUS_CANCELLED) return TRUE;
                        i_cal_time_set_timezone(shiftedStart.get(), selected->zone);
                        shiftWall(shiftedStart.get(), selected->shift);
                        if (selected->allDay) {
                            shiftedEnd.reset(i_cal_time_clone(shiftedStart.get()));
                            shiftWall(shiftedEnd.get(), selected->duration / 1000);
                        } else {
                            shiftedEnd.reset(i_cal_time_new_from_timet_with_zone((instant(shiftedStart.get(), state.zone) + selected->duration) / 1000,
                                FALSE, i_cal_timezone_get_utc_timezone()));
                        }
                    }
                    const auto begin = instant(shiftedStart.get(), state.zone), finish = instant(shiftedEnd.get(), state.zone);
                    if (begin >= state.to || (finish > begin ? finish <= state.from : begin < state.from)) return TRUE;
                    Object<ICalComponent> instance(i_cal_component_clone(selected ? selected->component : original), g_object_unref);
                    // Engine times carry their zone.
                    replaceTimes(instance.get(), shiftedStart.get(), shiftedEnd.get(), state.zone);
                    // An occurrence the rule makes is named by its series and original start.
                    const JSON occurrence = !state.detachedFrom.is_null() ? state.detachedFrom : state.series ? JSON(identity) : JSON(nullptr);
                    auto row = eventRow(instance.get(), state.stored, state.master, state.client, state.calendar, state.id, occurrence,
                        !state.detachedFrom.is_null());
                    state.bytes += row.dump().size();
                    if (state.result.size() >= 1000 || state.bytes > 512 * 1024) throw std::runtime_error("too many occurrences");
                    state.result.push_back(std::move(row));
                    return TRUE;
                } catch (...) { state.failed = true; return FALSE; }
            }, &state, e_cal_client_tzlookup_cb, client, zone, nullptr, &error.value);
        error.check(success && !state.failed);
    }
}

JSON calendarEvents(ESourceRegistry* registry, const JSON& input) {
    const auto from = milliseconds(input.at("start")), to = milliseconds(input.at("end"));
    if (to <= from || to - from > 1461LL * 86400000) throw std::runtime_error("invalid range");
    String location(e_cal_util_get_system_timezone_location(), g_free);
    auto zone = localZone();
    auto intervalStart = dateFromWire(from, true), intervalEnd = dateFromWire(to, true);
    String fromText(i_cal_time_as_ical_string(intervalStart.get()), g_free);
    String toText(i_cal_time_as_ical_string(intervalEnd.get()), g_free);
    // Only generated date strings enter this expression, never user query text.
    auto encodedZone = g_string_new(nullptr);
    e_sexp_encode_string(encodedZone, location.get());
    const auto query = std::string("(occur-in-time-range? (make-time \"") + fromText.get() + "\") (make-time \"" + toText.get() + "\") " + encodedZone->str + ")";
    g_string_free(encodedZone, TRUE);
    std::vector<Object<ICalComponent>> components;
    size_t inputBytes = 0, inputCount = 0, outputBytes = 0;
    JSON result = JSON::array();
    readCal(registry, "(or (has-recurrences?) " + query + ")", E_SOURCE_EXTENSION_CALENDAR, E_CAL_CLIENT_SOURCE_TYPE_EVENTS, {},
        [&](ICalComponent* component, ECalClient*, const std::string&) -> JSON {
            if (++inputCount > 1000) throw std::runtime_error("too many components");
            String encoded(i_cal_component_as_ical_string(component), g_free);
            if (!encoded) throw std::runtime_error("invalid component");
            inputBytes += strlen(encoded.get());
            if (inputBytes > 512 * 1024) throw std::runtime_error("too many calendar bytes");
            components.emplace_back(i_cal_component_clone(component), g_object_unref);
            return nullptr;
        }, [&](ECalClient* client, const std::string&) {
            // Range queries can omit detached occurrences. Fetch the complete
            // series through the error-returning UID API before expansion; a
            // moved-out override must still suppress its original occurrence.
            std::set<std::string> fetched;
            std::vector<Object<ICalComponent>> complete;
            for (auto& component : components) {
                const bool series = i_cal_component_count_properties(component.get(), I_CAL_RRULE_PROPERTY) ||
                    i_cal_component_count_properties(component.get(), I_CAL_RDATE_PROPERTY) ||
                    i_cal_component_count_properties(component.get(), I_CAL_RECURRENCEID_PROPERTY);
                if (!series) { complete.push_back(std::move(component)); continue; }
                const auto uid = bounded(i_cal_component_get_uid(component.get()));
                if (uid.empty()) throw std::runtime_error("missing series uid");
                if (!fetched.insert(uid).second) continue;
                Contacts objects;
                Error error;
                error.check(e_cal_client_get_objects_for_uid_sync(client, uid.c_str(), &objects.value, nullptr, &error.value) && objects.value);
                for (auto node = objects.value; node; node = node->next) {
                    auto item = e_cal_component_get_icalcomponent(E_CAL_COMPONENT(node->data));
                    String encoded(i_cal_component_as_ical_string(item), g_free);
                    if (!encoded || ++inputCount > 2000) throw std::runtime_error("too many series components");
                    inputBytes += strlen(encoded.get());
                    if (inputBytes > 1024 * 1024) throw std::runtime_error("too many calendar bytes");
                    complete.emplace_back(i_cal_component_clone(item), g_object_unref);
                }
            }
            expand(complete, client, calendarOf(client), zone, from, to, result, outputBytes);
            components.clear();
        });
    return result;
}

// The event `id` names, as the macOS helper finds it: of a repeating one, the occurrence that
// started at `occurrence` (its original start, within the tolerance) as calendar_read showed it,
// or the series without one. An occurrence changed on its own has an id of its own, which names it
// alone; a single event is found only at its own start.
struct Found {
    Object<ECalClient> client{nullptr, g_object_unref};
    Calendar calendar;
    std::string uid;
    // Of an occurrence changed on its own, the RECURRENCE-ID EDS keeps it by.
    std::string rid;
    std::vector<Object<ICalComponent>> series;
    ICalComponent* master = nullptr;
    // The occurrence changed on its own, or the event (the series) itself.
    ICalComponent* stored = nullptr;
    JSON row;
    // An occurrence the series' rule makes (not one changed on its own), and whether it is at the
    // series' own start.
    bool generated = false;
    bool atStart = false;
    int64_t occurrence = 0;
};
Found find(ESourceRegistry* registry, const std::string& id, const JSON& occurrence) {
    const auto parsed = parseEventID(id);
    Object<ESource> source(e_source_registry_ref_source(registry, parsed.source.c_str()), g_object_unref);
    if (!source || !e_source_has_extension(source.get(), E_SOURCE_EXTENSION_CALENDAR) || !e_source_registry_check_enabled(registry, source.get()))
        refuse("noSuchEvent");
    Found found;
    found.client = calClient(source.get(), E_CAL_CLIENT_SOURCE_TYPE_EVENTS);
    const auto client = found.client.get();
    found.calendar = calendarOf(client);
    found.uid = parsed.uid;
    {
        Contacts objects;
        Error error;
        const auto ok = e_cal_client_get_objects_for_uid_sync(client, parsed.uid.c_str(), &objects.value, nullptr, &error.value);
        if (!ok && g_error_matches(error.value, E_CAL_CLIENT_ERROR, E_CAL_CLIENT_ERROR_OBJECT_NOT_FOUND)) refuse("noSuchEvent");
        error.check(ok);
        size_t bytes = 0;
        for (auto node = objects.value; node; node = node->next) {
            auto item = e_cal_component_get_icalcomponent(E_CAL_COMPONENT(node->data));
            String encoded(i_cal_component_as_ical_string(item), g_free);
            if (!encoded || found.series.size() >= 2000) throw std::runtime_error("too many series components");
            bytes += strlen(encoded.get());
            if (bytes > 1024 * 1024) throw std::runtime_error("too many calendar bytes");
            found.series.emplace_back(i_cal_component_clone(item), g_object_unref);
        }
    }
    for (const auto& component : found.series) {
        const bool detached = i_cal_component_count_properties(component.get(), I_CAL_RECURRENCEID_PROPERTY);
        if (!detached && !found.master) found.master = component.get();
        if (detached && !parsed.rid.empty() && recurrenceIDText(component.get()) == parsed.rid) found.stored = component.get();
    }
    const auto local = localZone();
    const auto cancelled = [](ICalComponent* component) { return i_cal_component_get_status(component) == I_CAL_STATUS_CANCELLED; };
    if (!parsed.rid.empty()) {
        if (!found.stored || cancelled(found.stored)) refuse("noSuchEvent");
        found.rid = parsed.rid;
        Object<ICalProperty> rid(i_cal_component_get_first_property(found.stored, I_CAL_RECURRENCEID_PROPERTY), g_object_unref);
        Object<ICalTime> date(i_cal_property_get_recurrenceid(rid.get()), g_object_unref);
        found.occurrence = dateToWire(date.get(), rid.get(), client);
        auto view = shown(found.stored, client, local);
        found.row = eventRow(view.get(), found.stored, found.master, client, found.calendar, id, found.occurrence, true);
        return found;
    }
    if (!found.master || cancelled(found.master)) refuse("noSuchEvent");
    found.stored = found.master;
    const bool repeats = repeating(found.master);
    auto view = shown(found.master, client, local);
    found.row = eventRow(view.get(), found.master, found.master, client, found.calendar, eventID(found.calendar.id, found.uid), nullptr, false);
    found.occurrence = found.row["start"].get<int64_t>();
    const auto seriesStart = found.occurrence;
    if (repeats) found.row["occurrence"] = found.occurrence;
    if (occurrence.is_null()) return found;
    const auto named = occurrence.get<int64_t>();
    if (!repeats) {
        if (std::llabs(found.occurrence - named) > voice::HelperConfig::eventOccurrenceToleranceMs) refuse("noSuchEvent");
        return found;
    }
    JSON rows = JSON::array();
    size_t bytes = 0;
    expand(found.series, client, found.calendar, local, named - voice::HelperConfig::eventOccurrenceSearchSpanMs,
        named + voice::HelperConfig::eventOccurrenceSearchSpanMs, rows, bytes);
    const JSON* best = nullptr;
    int64_t distance = 0;
    for (const auto& row : rows) {
        if (row["occurrence"].is_null()) continue;
        const auto gap = std::llabs(row["occurrence"].get<int64_t>() - named);
        if (gap <= voice::HelperConfig::eventOccurrenceToleranceMs && (!best || gap < distance)) { best = &row; distance = gap; }
    }
    if (!best) refuse("noSuchEvent");
    found.row = *best;
    found.occurrence = found.row["occurrence"].get<int64_t>();
    if (found.row["isDetached"].get<bool>()) {
        found.rid = parseEventID(found.row["id"].get<std::string>()).rid;
        for (const auto& component : found.series)
            if (i_cal_component_count_properties(component.get(), I_CAL_RECURRENCEID_PROPERTY) && recurrenceIDText(component.get()) == found.rid) found.stored = component.get();
    } else {
        found.generated = true;
        found.atStart = found.occurrence == seriesStart;
    }
    return found;
}

// The RECURRENCE-ID of the occurrence a rule makes at `occurrence`: the instant in UTC, or its day.
// Google finds an occurrence by the UTC time EDS gives it, never by a local time with a zone.
std::string ridText(int64_t occurrence, bool allDay) {
    auto time = dateFromWire(occurrence, !allDay);
    String value(i_cal_time_as_ical_string(time.get()), g_free);
    return bounded(value.get());
}

// How an event repeats, as the app sends it (the macOS helper's fields), checked in full: a field
// that doesn't read is refused, never dropped (a count dropped repeats for ever).
struct Rule {
    std::string text;
    JSON until;
};
Rule ruleFrom(const JSON& value) {
    if (!value.is_object()) throw std::runtime_error("invalid rule");
    const auto frequency = text(value, "frequency");
    if (frequency != "DAILY" && frequency != "WEEKLY" && frequency != "MONTHLY" && frequency != "YEARLY") throw std::runtime_error("invalid rule");
    const auto number = [](const JSON& item, int64_t low, int64_t high) {
        if (!item.is_number_integer() || item.get<int64_t>() < low || item.get<int64_t>() > high || (low < 0 && item.get<int64_t>() == 0))
            throw std::runtime_error("invalid rule number");
        return std::to_string(item.get<int64_t>());
    };
    Rule result{"FREQ=" + frequency + ";INTERVAL=" + number(value.at("interval"), 1, G_MAXINT32), nullptr};
    const auto& count = value.at("count");
    if (!count.is_null()) result.text += ";COUNT=" + number(count, 1, G_MAXINT32);
    if (!value.at("until").is_null()) {
        if (!count.is_null()) throw std::runtime_error("rule with count and until");
        result.until = milliseconds(value.at("until"));
    }
    const auto list = [&](const char* key, const char* name, int64_t low, int64_t high) {
        const auto& items = value.at(key);
        if (!items.is_array() || items.size() > 366) throw std::runtime_error("invalid rule list");
        std::string joined;
        for (const auto& item : items) joined += (joined.empty() ? "" : ",") + number(item, low, high);
        if (!joined.empty()) result.text += std::string(";") + name + "=" + joined;
    };
    const auto& days = value.at("days");
    if (!days.is_array() || days.size() > 366) throw std::runtime_error("invalid rule days");
    std::string joined;
    for (const auto& day : days) {
        if (!day.is_object()) throw std::runtime_error("invalid rule day");
        const auto weekday = std::stoi(number(day.at("weekday"), 1, 7));
        const auto& week = day.at("week");
        if (!week.is_number_integer() || week.get<int64_t>() < -53 || week.get<int64_t>() > 53) throw std::runtime_error("invalid rule week");
        joined += (joined.empty() ? "" : ",") + (week.get<int64_t>() == 0 ? std::string{} : std::to_string(week.get<int64_t>())) + weekdayCodes[weekday - 1];
    }
    if (!joined.empty()) result.text += ";BYDAY=" + joined;
    list("monthDays", "BYMONTHDAY", -31, 31);
    list("months", "BYMONTH", 1, 12);
    list("yearWeeks", "BYWEEKNO", -53, 53);
    list("yearDays", "BYYEARDAY", -366, 366);
    list("positions", "BYSETPOS", -366, 366);
    return result;
}
// Replaces `component`'s rule: UNTIL is UTC for a timed event (RFC 5545 with a zoned start), the
// day for an all-day one.
void setRule(ICalComponent* component, const Rule& rule, bool allDay) {
    removeAll(component, I_CAL_RRULE_PROPERTY);
    auto encoded = rule.text;
    if (!rule.until.is_null()) encoded += ";UNTIL=" + ridText(rule.until.get<int64_t>(), allDay);
    Object<ICalRecurrence> recurrence(i_cal_recurrence_new_from_string(encoded.c_str()), g_object_unref);
    if (!recurrence) throw std::runtime_error("invalid rule");
    i_cal_component_take_property(component, i_cal_property_new_rrule(recurrence.get()));
}
void clearRule(ICalComponent* component) {
    for (const auto kind : {I_CAL_RRULE_PROPERTY, I_CAL_RDATE_PROPERTY, I_CAL_EXRULE_PROPERTY, I_CAL_EXDATE_PROPERTY}) removeAll(component, kind);
}

// Sets `component`'s times: a timed event's at `zone` (UTC without one); an all-day event's as days,
// from the inclusive last day the app sends to the exclusive end EDS keeps.
void setTimes(ICalComponent* component, int64_t start, int64_t end, bool allDay, ICalTimezone* zone) {
    for (const auto kind : {I_CAL_DTSTART_PROPERTY, I_CAL_DTEND_PROPERTY, I_CAL_DURATION_PROPERTY}) removeAll(component, kind);
    auto first = dateFromWire(start, !allDay), last = dateFromWire(end, !allDay);
    if (allDay) i_cal_time_adjust(last.get(), 1, 0, 0, 0);
    else if (zone) {
        first.reset(i_cal_time_new_from_timet_with_zone(start / 1000, FALSE, zone));
        last.reset(i_cal_time_new_from_timet_with_zone(end / 1000, FALSE, zone));
        // libical 3.0 converts to the zone's wall time but labels the result UTC: without the zone
        // set again, 09:00 in Toronto would be stored as 09:00 UTC.
        i_cal_time_set_timezone(first.get(), zone);
        i_cal_time_set_timezone(last.get(), zone);
    }
    i_cal_component_set_dtstart(component, first.get());
    i_cal_component_set_dtend(component, last.get());
}
// The zone `component`'s start has a TZID for; null for UTC, floating or a day.
ICalTimezone* startZone(ICalComponent* component, ECalClient* client) {
    Object<ICalTime> start(i_cal_component_get_dtstart(component), g_object_unref);
    if (!start || i_cal_time_is_date(start.get()) || i_cal_time_is_utc(start.get())) return nullptr;
    Object<ICalProperty> property(i_cal_component_get_first_property(component, I_CAL_DTSTART_PROPERTY), g_object_unref);
    Object<ICalParameter> parameter(property ? i_cal_property_get_first_parameter(property.get(), I_CAL_TZID_PARAMETER) : nullptr, g_object_unref);
    if (!parameter) return nullptr;
    ICalTimezone* zone = nullptr;
    Error error;
    error.check(e_cal_client_get_timezone_sync(client, i_cal_parameter_get_tzid(parameter.get()), &zone, nullptr, &error.value) && zone);
    return zone;
}
// The provider needs a zone a timed start refers to before it stores the event.
void addZone(ICalComponent* component, ECalClient* client, ICalTimezone* zone) {
    Object<ICalTime> start(i_cal_component_get_dtstart(component), g_object_unref);
    if (!zone || !start || i_cal_time_is_date(start.get()) || i_cal_time_is_utc(start.get())) return;
    Error error;
    error.check(e_cal_client_add_timezone_sync(client, zone, nullptr, &error.value));
}
// `date` moved by as many calendar days as `from` is from `to`, to `to`'s time of day, counted in
// `zone`: across a daylight-saving change, the same number of seconds would land an hour off.
int64_t moved(int64_t date, int64_t from, int64_t to, ICalTimezone* zone) {
    const auto at = [&](int64_t value) { return Object<ICalTime>(i_cal_time_new_from_timet_with_zone(value / 1000, FALSE, zone), g_object_unref); };
    const auto day = [](ICalTime* value) {
        return static_cast<int64_t>(g_date_get_julian(std::unique_ptr<GDate, decltype(&g_date_free)>(g_date_new_dmy(static_cast<GDateDay>(i_cal_time_get_day(value)),
            static_cast<GDateMonth>(i_cal_time_get_month(value)), static_cast<GDateYear>(i_cal_time_get_year(value))), g_date_free).get()));
    };
    auto origin = at(from), target = at(to), result = at(date);
    i_cal_time_adjust(result.get(), static_cast<int>(day(target.get()) - day(origin.get())), 0, 0, 0);
    i_cal_time_set_hour(result.get(), i_cal_time_get_hour(target.get()));
    i_cal_time_set_minute(result.get(), i_cal_time_get_minute(target.get()));
    i_cal_time_set_second(result.get(), i_cal_time_get_second(target.get()));
    return static_cast<int64_t>(i_cal_time_as_timet_with_zone(result.get(), zone)) * 1000;
}

// People to invite, as the app sends them: each address and name goes into the stored event as a
// URI or a parameter, which hold no line breaks or quotes.
struct Invitee { std::string email, name; };
bool plain(const std::string& value, bool spaces) {
    return std::none_of(value.begin(), value.end(), [&](char character) {
        const auto byte = static_cast<unsigned char>(character);
        return byte < 0x20 || byte == 0x7f || character == '"' || (!spaces && (character == ' ' || character == ':' || character == '<' || character == '>' || character == ','));
    });
}
std::vector<Invitee> invitees(const JSON& value) {
    if (!value.is_array()) throw std::runtime_error("invalid attendees");
    std::vector<Invitee> result;
    for (const auto& item : value) {
        if (!item.is_object()) throw std::runtime_error("invalid attendee");
        const auto email = text(item, "email");
        const auto name = item.at("name").is_null() ? std::string{} : text(item, "name");
        if (address(("mailto:" + email).c_str()).empty() || !plain(email, false) || !plain(name, true)) throw std::runtime_error("invalid attendee");
        result.push_back({email, name});
    }
    return result;
}
void invite(ICalComponent* component, const std::vector<Invitee>& people, const Calendar& calendar) {
    if (people.empty()) return;
    // The calendar's server sends the invitations, from the organizer: the user.
    if (!i_cal_component_count_properties(component, I_CAL_ORGANIZER_PROPERTY))
        i_cal_component_take_property(component, i_cal_property_new_organizer(("mailto:" + calendar.own).c_str()));
    std::set<std::string> present;
    for (auto raw = i_cal_component_get_first_property(component, I_CAL_ATTENDEE_PROPERTY); raw;
         raw = i_cal_component_get_next_property(component, I_CAL_ATTENDEE_PROPERTY)) {
        Object<ICalProperty> property(raw, g_object_unref);
        present.insert(lowered(address(i_cal_property_get_attendee(property.get()))));
    }
    for (const auto& who : people) {
        if (!present.insert(lowered(who.email)).second) continue;
        auto property = i_cal_property_new_attendee(("mailto:" + who.email).c_str());
        if (!who.name.empty()) i_cal_property_take_parameter(property, i_cal_parameter_new_cn(who.name.c_str()));
        i_cal_property_take_parameter(property, i_cal_parameter_new_role(I_CAL_ROLE_REQPARTICIPANT));
        i_cal_property_take_parameter(property, i_cal_parameter_new_partstat(I_CAL_PARTSTAT_NEEDSACTION));
        i_cal_property_take_parameter(property, i_cal_parameter_new_rsvp(I_CAL_RSVP_TRUE));
        i_cal_component_take_property(component, property);
    }
}
void setAvailability(ICalComponent* component, const std::string& availability) {
    removeAll(component, I_CAL_TRANSP_PROPERTY);
    i_cal_component_take_property(component, i_cal_property_new_transp(availability == "free" ? I_CAL_TRANSP_TRANSPARENT : I_CAL_TRANSP_OPAQUE));
}

void requireWritable(ECalClient* client) {
    if (e_client_is_readonly(E_CLIENT(client))) refuse("calendarReadOnly");
}
// A series repeating by a rule the app can't be told (by the hour, by RDATE alone, or a key libical
// doesn't know) reads as a single event, so the user would confirm a change to one event and change
// every occurrence. It is changed and deleted in the user's calendar app instead; an occurrence changed
// on its own is changed and deleted alone, so it can be here.
void requireDescribedRule(const Found& found) {
    if (found.rid.empty() && repeating(found.master) && recurrence(found.master, found.client.get()).is_null()) refuse("unsupportedRecurrence");
}
// Changing a series whose rule the app reads only in part (dates added by RDATE, removed by EXRULE) would
// leave those behind, and an occurrence another app changed with all after it (a RANGE recurrence id)
// takes its fields from that change, not the series: such a series is changed in the user's calendar app,
// though an occurrence changed on its own alone is still changed here when nothing has a RANGE.
void requireEditableSeries(const Found& found) {
    if (found.rid.empty() && found.master && (i_cal_component_count_properties(found.master, I_CAL_RDATE_PROPERTY) ||
        i_cal_component_count_properties(found.master, I_CAL_EXRULE_PROPERTY)))
        refuse("unsupportedRecurrence");
    for (const auto& component : found.series) {
        Object<ICalProperty> rid(i_cal_component_get_first_property(component.get(), I_CAL_RECURRENCEID_PROPERTY), g_object_unref);
        Object<ICalParameter> range(rid ? i_cal_property_get_first_parameter(rid.get(), I_CAL_RANGE_PARAMETER) : nullptr, g_object_unref);
        if (range) refuse("unsupportedRecurrence");
    }
}
// A timed start with neither a zone nor UTC: read, as EDS reads it, in the user's zone.
bool floating(ICalComponent* component) {
    Object<ICalTime> start(i_cal_component_get_dtstart(component), g_object_unref);
    return start && !i_cal_time_is_null_time(start.get()) && !i_cal_time_is_date(start.get()) && !i_cal_time_is_utc(start.get()) && !i_cal_time_get_timezone(start.get());
}
// A split's recurrence id: the occurrence named, in the series' own zone. EDS's server backends make
// that the new series' start as it is, without the conversion its local one makes.
Object<ICalProperty> splitRecurrenceID(int64_t occurrence, bool allDay, ICalTimezone* zone) {
    auto rid = dateFromWire(occurrence, !allDay);
    if (!zone || allDay) return Object<ICalProperty>(i_cal_property_new_recurrenceid(rid.get()), g_object_unref);
    rid.reset(i_cal_time_new_from_timet_with_zone(occurrence / 1000, FALSE, zone));
    i_cal_time_set_timezone(rid.get(), zone);
    Object<ICalProperty> property(i_cal_property_new_recurrenceid(rid.get()), g_object_unref);
    i_cal_property_take_parameter(property.get(), i_cal_parameter_new_tzid(i_cal_timezone_get_tzid(zone)));
    return property;
}
// EDS changes the whole series for a split at its first occurrence (an excluded start doesn't
// count). Asked as EDS decides it: from the recurrence id as its backend parses it off the wire.
bool firstInstance(const Found& found, ICalProperty* rid) {
    String text(i_cal_property_as_ical_string(rid), g_free);
    Object<ICalComponent> parsed(i_cal_component_new_from_string(("BEGIN:VEVENT\r\n" + std::string(text.get()) + "END:VEVENT\r\n").c_str()), g_object_unref);
    Object<ICalTime> time(parsed ? i_cal_component_get_recurrenceid(parsed.get()) : nullptr, g_object_unref);
    Object<ECalComponent> series(e_cal_component_new_from_icalcomponent(i_cal_component_clone(found.master)), g_object_unref);
    if (!time || i_cal_time_is_null_time(time.get()) || !series) throw std::runtime_error("invalid series");
    return e_cal_util_is_first_instance(series.get(), time.get(), e_cal_client_tzlookup_cb, found.client.get());
}
// Invitations need a calendar whose server sends them (Google, Nextcloud), and the user's address
// on it: a calendar on this computer has neither.
void requireInvitations(ECalClient* client, const Calendar& calendar) {
    if (!e_client_check_capability(E_CLIENT(client), E_CAL_STATIC_CAPABILITY_SAVE_SCHEDULES) || calendar.own.empty()) refuse("calendarNoInvitations");
}
Object<ESource> calendarSource(ESourceRegistry* registry, const std::string& id) {
    Object<ESource> source(e_source_registry_ref_source(registry, id.c_str()), g_object_unref);
    if (!source || !e_source_has_extension(source.get(), E_SOURCE_EXTENSION_CALENDAR) || !e_source_registry_check_enabled(registry, source.get()))
        refuse("noSuchCalendar");
    return source;
}

// The calendars events can be added to: every enabled one the user can write to.
JSON calendars(ESourceRegistry* registry) {
    Sources sources{e_source_registry_list_enabled(registry, E_SOURCE_EXTENSION_CALENDAR)};
    if (g_list_length(sources.value) > 32) throw std::runtime_error("too many sources");
    Object<ESource> fallback(e_source_registry_ref_default_calendar(registry), g_object_unref);
    JSON result = JSON::array();
    for (auto node = sources.value; node; node = node->next) {
        const auto source = E_SOURCE(node->data);
        auto client = calClient(source, E_CAL_CLIENT_SOURCE_TYPE_EVENTS);
        if (e_client_is_readonly(E_CLIENT(client.get()))) continue;
        // The account it belongs to, as GNOME Calendar heads it ("On This Computer", an address).
        const auto parentID = e_source_get_parent(source);
        Object<ESource> parent(parentID ? e_source_registry_ref_source(registry, parentID) : nullptr, g_object_unref);
        const auto id = bounded(e_source_get_uid(source));
        result.push_back({{"id", id}, {"title", bounded(e_source_get_display_name(source))},
            {"account", parent ? bounded(e_source_get_display_name(parent.get())) : std::string{}},
            {"isDefault", fallback && id == bounded(e_source_get_uid(fallback.get()))}});
    }
    return result;
}

JSON calendarEventRead(ESourceRegistry* registry, const JSON& input) {
    return find(registry, text(input, "id"), input.at("occurrence").is_null() ? JSON(nullptr) : JSON(milliseconds(input.at("occurrence")))).row;
}

// Adds an event to the calendar `calendarId` names, or the default one, inviting `attendees`
// through the calendar's server; the app sends those fields only where it can edit events.
JSON calendarAdd(ESourceRegistry* registry, const JSON& input) {
    const auto title = text(input, "title");
    const auto startMs = milliseconds(input.at("start")), endMs = milliseconds(input.at("end"));
    if (title.empty() || !input.at("isAllDay").is_boolean() || endMs < startMs) throw std::runtime_error("invalid event");
    const bool allDay = input.at("isAllDay").get<bool>();
    const auto location = optionalText(input, "location"), notes = optionalText(input, "notes");
    const auto field = [&](const char* key) { return input.contains(key) ? input.at(key) : JSON(nullptr); };
    const auto calendarID = field("calendarId"), availability = field("availability"), repeat = field("recurrence"), people = field("attendees");
    if (!availability.is_null() && availability != "busy" && availability != "free") throw std::runtime_error("invalid availability");
    std::optional<Rule> rule;
    if (!repeat.is_null()) rule = ruleFrom(repeat);
    const auto invited = people.is_null() ? std::vector<Invitee>{} : invitees(people);
    Object<ESource> source(nullptr, g_object_unref);
    if (calendarID.is_null()) {
        source.reset(e_source_registry_ref_default_calendar(registry));
        if (!source) refuse("noDefaultCalendar");
    } else {
        source = calendarSource(registry, text(JSON{{"value", calendarID}}, "value"));
    }
    auto client = calClient(source.get(), E_CAL_CLIENT_SOURCE_TYPE_EVENTS);
    requireWritable(client.get());
    const auto calendar = calendarOf(client.get());
    if (!invited.empty()) requireInvitations(client.get(), calendar);
    Object<ICalComponent> component(i_cal_component_new_vevent(), g_object_unref);
    String uid(g_uuid_string_random(), g_free);
    i_cal_component_set_uid(component.get(), uid.get());
    i_cal_component_set_summary(component.get(), title.c_str());
    // A repeating event keeps its time of day in the user's zone across a daylight-saving change.
    const auto zone = rule && !allDay ? localZone() : nullptr;
    setTimes(component.get(), startMs, endMs, allDay, zone);
    if (!location.is_null()) i_cal_component_set_location(component.get(), location.get<std::string>().c_str());
    if (!notes.is_null()) i_cal_component_set_description(component.get(), notes.get<std::string>().c_str());
    if (!availability.is_null()) setAvailability(component.get(), availability.get<std::string>());
    if (rule) setRule(component.get(), *rule, allDay);
    invite(component.get(), invited, calendar);
    Object<ICalTime> now(i_cal_time_new_current_with_zone(i_cal_timezone_get_utc_timezone()), g_object_unref);
    i_cal_component_set_dtstamp(component.get(), now.get());
    addZone(component.get(), client.get(), zone);
    // Construct the response before writing, so invalid provider values cannot
    // turn a successful write into an avoidable post-write failure.
    auto view = shown(component.get(), client.get(), localZone());
    auto result = eventRow(view.get(), component.get(), component.get(), client.get(), calendar, eventID(calendar.id, uid.get()),
        rule ? JSON(calendarEvent(view.get(), client.get(), calendar.title)["start"]) : JSON(nullptr), false);
    Error error;
    gchar* rawUID = nullptr;
    // The calendar's server emails the invitations: the helper sends nothing.
    const auto ok = e_cal_client_create_object_sync(client.get(), component.get(), E_CAL_OPERATION_FLAG_NONE, &rawUID, nullptr, &error.value);
    String savedUID(rawUID, g_free);
    error.check(ok);
    if (savedUID && std::string(savedUID.get()) != uid.get()) result["id"] = eventID(calendar.id, bounded(savedUID.get()));
    return result;
}

void removeOccurrence(ECalClient* client, const std::string& uid, const char* rid, ECalObjModType mod) {
    Error error;
    const auto ok = e_cal_client_remove_object_sync(client, uid.c_str(), rid, mod, E_CAL_OPERATION_FLAG_NONE, nullptr, &error.value);
    if (!ok && g_error_matches(error.value, E_CAL_CLIENT_ERROR, E_CAL_CLIENT_ERROR_OBJECT_NOT_FOUND)) refuse("noSuchEvent");
    error.check(ok);
}

// The series in `before`'s calendar, other than its own, that start at `start`: the one a change to
// an occurrence and every one after it splits off is among them, under a uid EDS gives it.
std::set<std::string> seriesStarting(const Found& before, int64_t start) {
    const auto client = before.client.get();
    auto from = dateFromWire(start - 1000, true), to = dateFromWire(start + 1000, true);
    String fromText(i_cal_time_as_ical_string(from.get()), g_free), toText(i_cal_time_as_ical_string(to.get()), g_free);
    // Only generated date strings and the zone's name enter this expression; days count in the
    // user's zone, as calendarEvents counts them.
    String location(e_cal_util_get_system_timezone_location(), g_free);
    if (!location) throw std::runtime_error("no local timezone");
    auto encodedZone = g_string_new(nullptr);
    e_sexp_encode_string(encodedZone, location.get());
    const auto query = std::string("(occur-in-time-range? (make-time \"") + fromText.get() + "\") (make-time \"" + toText.get() + "\") " + encodedZone->str + ")";
    g_string_free(encodedZone, TRUE);
    GSList* raw = nullptr;
    Error error;
    const auto ok = e_cal_client_get_object_list_sync(client, query.c_str(), &raw, nullptr, &error.value);
    std::unique_ptr<GSList, void(*)(GSList*)> objects(raw, [](GSList* list) { g_slist_free_full(list, g_object_unref); });
    error.check(ok);
    const auto local = localZone();
    std::set<std::string> result;
    for (auto node = objects.get(); node; node = node->next) {
        const auto component = I_CAL_COMPONENT(node->data);
        const auto uid = bounded(i_cal_component_get_uid(component));
        if (uid == before.uid || i_cal_component_count_properties(component, I_CAL_RECURRENCEID_PROPERTY)) continue;
        auto startTime = calendarTime(component, I_CAL_DTSTART_PROPERTY, client, local);
        if (instant(startTime.get(), local) == start) result.insert(uid);
    }
    return result;
}

// Saves `edited` over the occurrences `mod` covers, with a higher sequence: attendees' calendars
// take a change by it.
void save(const Found& found, ICalComponent* edited, ECalObjModType mod, ICalTimezone* zone) {
    i_cal_component_set_sequence(edited, i_cal_component_get_sequence(edited) + 1);
    Object<ICalTime> now(i_cal_time_new_current_with_zone(i_cal_timezone_get_utc_timezone()), g_object_unref);
    i_cal_component_set_dtstamp(edited, now.get());
    addZone(edited, found.client.get(), zone);
    Error error;
    const auto ok = e_cal_client_modify_object_sync(found.client.get(), edited, mod, E_CAL_OPERATION_FLAG_NONE, nullptr, &error.value);
    if (!ok && g_error_matches(error.value, E_CAL_CLIENT_ERROR, E_CAL_CLIENT_ERROR_OBJECT_NOT_FOUND)) refuse("noSuchEvent");
    error.check(ok);
}

// Changes the event `id` names (the occurrence at `occurrence` of a repeating one) over the
// occurrences `scope` covers, as the macOS helper does: see `EventKitStore.edit` there. The
// occurrences `exclude` names are each found before any is deleted, and deleted first.
JSON calendarEdit(ESourceRegistry* registry, const JSON& input) {
    const auto id = text(input, "id");
    const JSON occurrence = input.at("occurrence").is_null() ? JSON(nullptr) : JSON(milliseconds(input.at("occurrence")));
    const auto scope = text(input, "scope");
    if (scope != "all" && scope != "thisOnly" && scope != "thisAndFollowing") throw std::runtime_error("invalid scope");
    const auto given = [&](const char* key) { return input.contains(key) && !input.at(key).is_null(); };
    std::optional<std::string> title, location, notes, availability;
    if (given("title")) { title = text(input, "title"); if (title->empty()) throw std::runtime_error("empty title"); }
    if (given("location")) location = text(input, "location");
    if (given("notes")) notes = text(input, "notes");
    if (given("availability")) {
        availability = text(input, "availability");
        if (*availability != "busy" && *availability != "free") throw std::runtime_error("invalid availability");
    }
    std::optional<int64_t> start, end;
    if (given("start") != given("end")) throw std::runtime_error("start and end go together");
    if (given("start")) { start = milliseconds(input.at("start")); end = milliseconds(input.at("end")); if (*end < *start) throw std::runtime_error("invalid times"); }
    std::optional<bool> allDay;
    if (given("isAllDay")) { if (!input.at("isAllDay").is_boolean()) throw std::runtime_error("invalid all day"); allDay = input.at("isAllDay").get<bool>(); }
    // Absent keeps how the event repeats; null ends it.
    const bool ruleChanges = input.contains("recurrence");
    std::optional<Rule> rule;
    if (given("recurrence")) rule = ruleFrom(input.at("recurrence"));
    const auto invited = invitees(input.at("invite"));
    std::set<std::string> uninvited;
    if (!input.at("uninvite").is_array()) throw std::runtime_error("invalid uninvite");
    for (const auto& email : input.at("uninvite")) uninvited.insert(lowered(text(JSON{{"value", email}}, "value")));
    if (!input.at("exclude").is_array()) throw std::runtime_error("invalid exclude");
    std::vector<int64_t> exclude;
    for (const auto& date : input.at("exclude")) exclude.push_back(milliseconds(date));

    auto found = find(registry, id, occurrence);
    requireWritable(found.client.get());
    if (found.row["isInvitation"].get<bool>()) refuse("notOrganizer");
    requireDescribedRule(found);
    requireEditableSeries(found);
    // Removing someone tells them too, so it needs a calendar that sends invitations as adding does.
    if (!invited.empty() || !uninvited.empty()) requireInvitations(found.client.get(), found.calendar);
    // One occurrence can't repeat on its own: the app never asks it.
    if (ruleChanges && (!found.rid.empty() || (found.generated && scope == "thisOnly"))) throw std::runtime_error("invalid rule change");
    // Each still an occurrence of this series, all found before any is deleted: a refusal deletes none.
    // One changed on its own is deleted as itself, by its recurrence id.
    std::vector<std::string> excluded;
    for (const auto date : exclude) {
        const auto named = find(registry, id, date);
        if (named.rid.empty() && !(repeating(named.master) && named.row["occurrence"].is_number())) refuse("noSuchEvent");
        excluded.push_back(named.rid.empty() ? ridText(named.occurrence, named.row["isAllDay"].get<bool>()) : named.rid);
    }
    // Each committed as it goes.
    for (const auto& rid : excluded) removeOccurrence(found.client.get(), found.uid, rid.c_str(), E_CAL_OBJ_MOD_THIS);
    // Found again: the deletions changed the series.
    if (!excluded.empty()) found = find(registry, id, occurrence);
    const auto client = found.client.get();
    const auto asked = title || location || notes || availability || start || allDay || ruleChanges || !invited.empty() || !uninvited.empty();
    if (!asked) return found.row;

    const bool detached = !found.rid.empty();
    const auto rowStart = found.row["start"].get<int64_t>(), rowEnd = found.row["end"].get<int64_t>();
    const bool rowAllDay = found.row["isAllDay"].get<bool>();
    auto zone = startZone(found.stored, client);
    // Times written for a floating start are written in the user's zone, as they were read.
    if (!zone && floating(found.stored)) zone = localZone();
    Object<ICalProperty> split(found.generated && scope == "thisAndFollowing" ? splitRecurrenceID(found.occurrence, rowAllDay, zone) : Object<ICalProperty>(nullptr, g_object_unref));
    // Changed for every following occurrence from the first, the whole series changes.
    const bool alone = found.generated && (scope == "thisOnly" || (split && !firstInstance(found, split.get())));
    ECalObjModType mod = detached || (alone && scope == "thisOnly") ? E_CAL_OBJ_MOD_THIS : alone ? E_CAL_OBJ_MOD_THIS_AND_FUTURE : E_CAL_OBJ_MOD_ALL;
    Object<ICalComponent> edited(i_cal_component_clone(found.stored), g_object_unref);
    if (alone) {
        // The occurrence named, as it is.
        removeAll(edited.get(), I_CAL_RECURRENCEID_PROPERTY);
        if (split) i_cal_component_take_property(edited.get(), i_cal_property_clone(split.get()));
        else i_cal_component_set_recurrenceid(edited.get(), dateFromWire(found.occurrence, !rowAllDay).get());
        setTimes(edited.get(), rowStart, rowEnd, rowAllDay, zone);
    }
    if (mod == E_CAL_OBJ_MOD_THIS_AND_FUTURE) {
        // EDS counts the new series' COUNT from the series it ends, and puts back a start that still
        // falls on one of its occurrences: so the series is split as it is, and the change is then made
        // to the new series, the one starting there that wasn't before.
        const auto existing = seriesStarting(found, rowStart);
        save(found, edited.get(), mod, zone);
        auto split = seriesStarting(found, rowStart);
        for (const auto& uid : existing) split.erase(uid);
        if (split.size() != 1) throw std::runtime_error("split series not found");
        auto change = input;
        change["id"] = eventID(found.calendar.id, *split.begin());
        change["occurrence"] = nullptr;
        change["scope"] = "all";
        change["exclude"] = JSON::array();
        return calendarEdit(registry, change);
    }
    if (alone) clearRule(edited.get());
    const bool isAllDay = allDay.value_or(rowAllDay);
    if (ruleChanges) {
        if (rule) setRule(edited.get(), *rule, isAllDay);
        else clearRule(edited.get());
    }
    // A timed event made to repeat (or a day made timed) keeps its time of day in the user's zone across
    // a daylight-saving change; a series stored in UTC is left as it is.
    const bool rezone = !zone && !isAllDay && mod != E_CAL_OBJ_MOD_THIS && repeating(edited.get()) && ((rule && !repeating(found.stored)) || rowAllDay);
    if (rezone) zone = localZone();
    if (start || allDay || rezone) {
        const auto newStart = start.value_or(rowStart), newEnd = end.value_or(rowEnd);
        if (mod != E_CAL_OBJ_MOD_ALL || !found.generated || found.atStart) {
            // The occurrence named takes the times confirmed.
            setTimes(edited.get(), newStart, newEnd, isAllDay, zone);
        } else {
            // Every occurrence moves by as many days as the one named, to its new time of day; a timed
            // event keeps the length confirmed, an all-day one its days.
            const auto local = localZone();
            auto masterStart = calendarTime(found.stored, I_CAL_DTSTART_PROPERTY, client, local);
            const auto counted = isAllDay ? local : zone ? zone : i_cal_timezone_get_utc_timezone();
            const auto seriesStart = moved(instant(masterStart.get(), local), found.occurrence, newStart, counted);
            setTimes(edited.get(), seriesStart, isAllDay ? moved(seriesStart, newStart, newEnd, counted) : seriesStart + (newEnd - newStart), isAllDay, zone);
        }
    }
    if (title) i_cal_component_set_summary(edited.get(), title->c_str());
    if (location) {
        removeAll(edited.get(), I_CAL_LOCATION_PROPERTY);
        if (!location->empty()) i_cal_component_set_location(edited.get(), location->c_str());
    }
    if (notes) {
        removeAll(edited.get(), I_CAL_DESCRIPTION_PROPERTY);
        if (!notes->empty()) i_cal_component_set_description(edited.get(), notes->c_str());
    }
    if (availability) setAvailability(edited.get(), *availability);
    if (!uninvited.empty()) {
        // Never the organizer.
        Object<ICalProperty> organizerProperty(i_cal_component_get_first_property(edited.get(), I_CAL_ORGANIZER_PROPERTY), g_object_unref);
        const auto organizer = organizerProperty ? lowered(address(i_cal_property_get_organizer(organizerProperty.get()))) : std::string{};
        std::vector<Object<ICalProperty>> removed;
        for (auto raw = i_cal_component_get_first_property(edited.get(), I_CAL_ATTENDEE_PROPERTY); raw;
             raw = i_cal_component_get_next_property(edited.get(), I_CAL_ATTENDEE_PROPERTY)) {
            Object<ICalProperty> property(raw, g_object_unref);
            const auto email = lowered(address(i_cal_property_get_attendee(property.get())));
            if (!email.empty() && email != organizer && uninvited.contains(email)) removed.push_back(std::move(property));
        }
        for (const auto& property : removed) i_cal_component_remove_property(edited.get(), property.get());
    }
    invite(edited.get(), invited, found.calendar);
    save(found, edited.get(), mod, zone);
    if (mod == E_CAL_OBJ_MOD_THIS) return find(registry, eventID(found.calendar.id, found.uid, detached ? found.rid : recurrenceIDText(edited.get())), nullptr).row;
    return find(registry, eventID(found.calendar.id, found.uid), nullptr).row;
}

// Deletes the event `id` names, every occurrence of a repeating one; the calendar's server tells
// its attendees. An occurrence changed on its own has an id of its own, and is deleted alone.
JSON calendarDelete(ESourceRegistry* registry, const JSON& input) {
    const auto found = find(registry, text(input, "id"), nullptr);
    requireWritable(found.client.get());
    requireDescribedRule(found);
    if (found.rid.empty()) removeOccurrence(found.client.get(), found.uid, nullptr, E_CAL_OBJ_MOD_ALL);
    else removeOccurrence(found.client.get(), found.uid, found.rid.c_str(), E_CAL_OBJ_MOD_THIS);
    return JSON::object();
}

JSON run(const JSON& request) {
    const auto method = text(request, "method");
    const std::set<std::string> methods{"contactsSearch", "contactsAdd", "notesSearch", "notesAdd", "reminders", "reminderAdd", "calendarAdd",
        "calendarEvents", "calendars", "calendarEvent", "calendarEdit", "calendarDelete"};
    if (!methods.contains(method)) throw std::runtime_error("unknown operation");
    Error error;
    Object<ESourceRegistry> registry(e_source_registry_new_sync(nullptr, &error.value), g_object_unref);
    error.check(registry != nullptr);
    // A read writes nothing, so one refused for a change is made again from the start.
    const auto reread = [](const std::function<JSON()>& read) {
        for (unsigned attempt = 1;; ++attempt) {
            try { return read(); } catch (const SourceChanged&) { if (attempt >= voice::HelperConfig::calendarReadAttempts) throw; }
        }
    };
    if (method == "reminders") return reread([&] { return reminders(registry.get(), request.at("params")); });
    if (method == "notesSearch") return reread([&] { return notesSearch(registry.get(), request.at("params")); });
    try {
        if (method == "calendarEvents") return reread([&] { return calendarEvents(registry.get(), request.at("params")); });
        if (method == "calendarAdd") return calendarAdd(registry.get(), request.at("params"));
        if (method == "calendars") return calendars(registry.get());
        if (method == "calendarEvent") return calendarEventRead(registry.get(), request.at("params"));
        if (method == "calendarEdit") return calendarEdit(registry.get(), request.at("params"));
        if (method == "calendarDelete") return calendarDelete(registry.get(), request.at("params"));
    } catch (const Refusal& refusal) {
        return {{"refused", refusal.kind}};
    }
    if (method == "reminderAdd") return reminderAdd(registry.get(), request.at("params"));
    if (method == "notesAdd") return notesAdd(registry.get(), request.at("params"));
    return method == "contactsSearch" ? search(registry.get(), request.at("params")) : add(registry.get(), request.at("params"));
}
}
// Provider execution remains native; the bounded process transport is shared.
int main() { return voice_productivity::serve(run); }
