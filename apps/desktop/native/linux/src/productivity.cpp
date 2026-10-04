// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include <libebook/libebook.h>
#include "../../shared/productivity/process.h"
#include <libecal/libecal.h>
#include <nlohmann/json.hpp>
#include <iostream>
#include <functional>
#include <memory>
#include <map>
#include <set>
#include <stdexcept>
#include <string>

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
    void stop(bool failure) { failed = failed || failure; done = true; g_main_loop_quit(loop); }
};
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
                static_cast<MemoView*>(data)->stop(true);
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
JSON calendarAdd(ESourceRegistry* registry, const JSON& input) {
    const auto title = text(input, "title");
    const auto startMs = milliseconds(input.at("start")), endMs = milliseconds(input.at("end"));
    if (title.empty() || !input.at("isAllDay").is_boolean() || endMs < startMs) throw std::runtime_error("invalid event");
    const bool allDay = input.at("isAllDay").get<bool>();
    const auto location = optionalText(input, "location"), notes = optionalText(input, "notes");
    auto start = dateFromWire(startMs, !allDay), end = dateFromWire(endMs, !allDay);
    if (allDay) i_cal_time_adjust(end.get(), 1, 0, 0, 0);
    Object<ESource> source(e_source_registry_ref_default_calendar(registry), g_object_unref);
    auto client = calClient(source.get(), E_CAL_CLIENT_SOURCE_TYPE_EVENTS);
    if (e_client_is_readonly(E_CLIENT(client.get()))) throw std::runtime_error("read only");
    Object<ICalComponent> component(i_cal_component_new_vevent(), g_object_unref);
    String uid(g_uuid_string_random(), g_free);
    i_cal_component_set_uid(component.get(), uid.get());
    i_cal_component_set_summary(component.get(), title.c_str());
    i_cal_component_set_dtstart(component.get(), start.get());
    i_cal_component_set_dtend(component.get(), end.get());
    if (!location.is_null()) i_cal_component_set_location(component.get(), location.get<std::string>().c_str());
    if (!notes.is_null()) i_cal_component_set_description(component.get(), notes.get<std::string>().c_str());
    Object<ICalTime> now(i_cal_time_new_current_with_zone(i_cal_timezone_get_utc_timezone()), g_object_unref);
    i_cal_component_set_dtstamp(component.get(), now.get());
    auto result = calendarEvent(component.get(), client.get(), bounded(e_source_get_display_name(source.get())));
    Error error;
    gchar* rawUID = nullptr;
    const auto ok = e_cal_client_create_object_sync(client.get(), component.get(), E_CAL_OPERATION_FLAG_NONE, &rawUID, nullptr, &error.value);
    String savedUID(rawUID, g_free);
    error.check(ok);
    return result;
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
// Expand only a successfully completed snapshot, using EDS's error-returning
// recurrence engine rather than the void client convenience wrappers.
JSON calendarEvents(ESourceRegistry* registry, const JSON& input) {
    const auto from = milliseconds(input.at("start")), to = milliseconds(input.at("end"));
    if (to <= from || to - from > 1461LL * 86400000) throw std::runtime_error("invalid range");
    String location(e_cal_util_get_system_timezone_location(), g_free);
    auto zone = location ? i_cal_timezone_get_builtin_timezone(location.get()) : nullptr;
    if (!zone) throw std::runtime_error("no local timezone");
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
        }, [&](ECalClient* client, const std::string& calendar) {
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
            components = std::move(complete);
            std::map<std::string, std::set<int64_t>> overrides;
            std::map<std::string, std::vector<CalendarRange>> ranges;
            for (const auto& component : components) {
                Object<ICalProperty> rid(i_cal_component_get_first_property(component.get(), I_CAL_RECURRENCEID_PROPERTY), g_object_unref);
                if (!rid) continue;
                Object<ICalParameter> range(i_cal_property_get_first_parameter(rid.get(), I_CAL_RANGE_PARAMETER), g_object_unref);
                Object<ICalTime> date(i_cal_property_get_recurrenceid(rid.get()), g_object_unref);
                const auto uid = bounded(i_cal_component_get_uid(component.get()));
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
                struct Expansion {
                    ECalClient* client;
                    const std::string& calendar;
                    JSON& result;
                    size_t& bytes;
                    const std::set<int64_t>* overrides;
                    const std::vector<CalendarRange>* ranges;
                    ICalTimezone* zone;
                    int64_t from, to;
                    size_t visited = 0;
                    bool failed = false;
                } state{client, calendar, result, outputBytes,
                    rid ? nullptr : &overrides[bounded(i_cal_component_get_uid(component.get()))],
                    rid ? nullptr : &ranges[bounded(i_cal_component_get_uid(component.get()))], zone, from, to};
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
                            // Engine times carry their zone. Replace the original
                            // dates and their stale TZID parameters with UTC (DATE
                            // values remain DATE for the shared all-day contract).
                            auto set = [&](ICalTime* value, ICalPropertyKind kind) {
                                while (auto raw = i_cal_component_get_first_property(instance.get(), kind)) {
                                    Object<ICalProperty> owned(raw, g_object_unref);
                                    i_cal_component_remove_property(instance.get(), raw);
                                }
                                Object<ICalTime> normalized(i_cal_time_clone(value), g_object_unref);
                                if (!i_cal_time_is_date(value)) {
                                    const auto seconds = i_cal_time_as_timet_with_zone(value, i_cal_time_get_timezone(value) ? i_cal_time_get_timezone(value) : state.zone);
                                    normalized.reset(i_cal_time_new_from_timet_with_zone(seconds, FALSE, i_cal_timezone_get_utc_timezone()));
                                }
                                if (kind == I_CAL_DTSTART_PROPERTY) i_cal_component_set_dtstart(instance.get(), normalized.get());
                                else i_cal_component_set_dtend(instance.get(), normalized.get());
                            };
                            // DTEND cannot coexist with DURATION.
                            while (auto raw = i_cal_component_get_first_property(instance.get(), I_CAL_DURATION_PROPERTY)) {
                                Object<ICalProperty> owned(raw, g_object_unref);
                                i_cal_component_remove_property(instance.get(), raw);
                            }
                            set(shiftedStart.get(), I_CAL_DTSTART_PROPERTY);
                            set(shiftedEnd.get(), I_CAL_DTEND_PROPERTY);
                            auto row = calendarEvent(instance.get(), state.client, state.calendar);
                            state.bytes += row.dump().size();
                            if (state.result.size() >= 1000 || state.bytes > 512 * 1024) throw std::runtime_error("too many occurrences");
                            state.result.push_back(std::move(row));
                            return TRUE;
                        } catch (...) { state.failed = true; return FALSE; }
                    }, &state, e_cal_client_tzlookup_cb, client, zone, nullptr, &error.value);
                error.check(success && !state.failed);
            }
            components.clear();
        });
    return result;
}

JSON run(const JSON& request) {
    const auto method = text(request, "method");
    if (method != "contactsSearch" && method != "contactsAdd" && method != "notesSearch" && method != "notesAdd" && method != "reminders" && method != "reminderAdd" && method != "calendarAdd" && method != "calendarEvents") throw std::runtime_error("unknown operation");
    Error error;
    Object<ESourceRegistry> registry(e_source_registry_new_sync(nullptr, &error.value), g_object_unref);
    error.check(registry != nullptr);
    if (method == "calendarEvents") return calendarEvents(registry.get(), request.at("params"));
    if (method == "calendarAdd") return calendarAdd(registry.get(), request.at("params"));
    if (method == "reminders") return reminders(registry.get(), request.at("params"));
    if (method == "reminderAdd") return reminderAdd(registry.get(), request.at("params"));
    if (method == "notesSearch") return notesSearch(registry.get(), request.at("params"));
    if (method == "notesAdd") return notesAdd(registry.get(), request.at("params"));
    return method == "contactsSearch" ? search(registry.get(), request.at("params")) : add(registry.get(), request.at("params"));
}
}
// Provider execution remains native; the bounded process transport is shared.
int main() { return voice_productivity::serve(run); }
