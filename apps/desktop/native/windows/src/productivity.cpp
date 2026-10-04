// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include <windows.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.ApplicationModel.Contacts.h>
#include <winrt/Windows.ApplicationModel.Appointments.h>
#include <map>
#include <optional>
#include <vector>
#include <algorithm>
#include <chrono>
#include <stdexcept>
#include "../../shared/productivity/process.h"

namespace {
using JSON = nlohmann::json;
using namespace winrt;
using namespace Windows::ApplicationModel::Contacts;

std::string text(const JSON& input, const char* key) {
    const auto value = input.at(key).get<std::string>();
    if (value.size() > 32768 || value.find('\0') != std::string::npos) throw std::runtime_error("invalid field");
    return value;
}
std::string field(hstring const& value) {
    if (value.size() > 32768) throw std::runtime_error("field too large");
    const auto result = to_string(value);
    if (result.size() > 32768 || result.find('\0') != std::string::npos) throw std::runtime_error("invalid field");
    return result;
}
template<class A> auto awaitProvider(A const& operation) {
    if (operation.wait_for(std::chrono::seconds(10)) == Windows::Foundation::AsyncStatus::Started) {
        operation.Cancel(); throw std::runtime_error("provider timed out");
    }
    return operation.get();
}
JSON card(Contact const& contact) {
    if (!contact || contact.Emails().Size() > 100 || contact.Phones().Size() > 100 || contact.JobInfo().Size() > 100)
        throw std::runtime_error("invalid contact");
    JSON emails = JSON::array(), phones = JSON::array();
    for (auto const& value : contact.Emails()) emails.push_back(field(value.Address()));
    for (auto const& value : contact.Phones()) phones.push_back(field(value.Number()));
    std::string company;
    for (auto const& job : contact.JobInfo()) {
        auto name = field(job.CompanyName());
        if (!name.empty()) { company = std::move(name); break; }
    }
    return {{"firstName", field(contact.FirstName())}, {"lastName", field(contact.LastName())},
        {"organization", company}, {"emails", emails}, {"phones", phones}};
}
Contact draft(const JSON& input) {
    Contact result;
    result.FirstName(to_hstring(text(input, "firstName")));
    result.LastName(to_hstring(text(input, "lastName")));
    const auto company = text(input, "organization");
    if (!company.empty()) { ContactJobInfo job; job.CompanyName(to_hstring(company)); result.JobInfo().Append(job); }
    for (const auto* key : {"emails", "phones"}) {
        auto const& values = input.at(key);
        if (!values.is_array() || values.size() > 1) throw std::runtime_error("invalid values");
        for (auto const& value : values) {
            const auto parsed = text(JSON{{"value", value}}, "value");
            if (std::string_view(key) == "emails") { ContactEmail email; email.Address(to_hstring(parsed)); result.Emails().Append(email); }
            else { ContactPhone phone; phone.Number(to_hstring(parsed)); result.Phones().Append(phone); }
        }
    }
    if (result.FirstName().empty() && result.LastName().empty() && company.empty() && result.Emails().Size() == 0)
        throw std::runtime_error("empty contact");
    return result;
}
JSON search(const JSON& input) {
    const auto query = text(input, "query");
    const auto& rawLimit = input.at("limit");
    if (query.empty() || !rawLimit.is_number_integer() || rawLimit < 1 || rawLimit > 100)
        throw std::runtime_error("invalid query");
    const auto limit = rawLimit.get<size_t>();
    auto store = awaitProvider(ContactManager::RequestStoreAsync(ContactStoreAccessType::AllContactsReadOnly));
    if (!store) throw std::runtime_error("no store");
    ContactQueryOptions options(to_hstring(query));
    options.TextSearch().SearchScope(ContactQuerySearchScope::Local);
    auto reader = store.GetContactReader(options);
    JSON result = JSON::array();
    size_t bytes = 0;
    while (result.size() < limit) {
        auto batch = awaitProvider(reader.ReadBatchAsync());
        if (batch.Status() != ContactBatchStatus::Success) throw std::runtime_error("provider query failed");
        if (batch.Contacts().Size() == 0) break;
        for (auto const& contact : batch.Contacts()) {
            auto row = card(contact); bytes += row.dump().size();
            if (bytes > 512 * 1024) throw std::runtime_error("results too large");
            result.push_back(std::move(row));
            if (result.size() == limit) break;
        }
    }
    return result;
}
struct WriteLock {
    HANDLE handle = CreateMutexW(nullptr, FALSE, L"Local\\TabMailVoiceProductivityWrite");
    bool owned = false;
    WriteLock() {
        if (!handle) throw std::runtime_error("no write lock");
        const auto wait = WaitForSingleObject(handle, 10000);
        owned = wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED;
        if (!owned) { CloseHandle(handle); handle = nullptr; throw std::runtime_error("write busy"); }
    }
    ~WriteLock() { if (owned) ReleaseMutex(handle); if (handle) CloseHandle(handle); }
    WriteLock(WriteLock const&) = delete;
    WriteLock& operator=(WriteLock const&) = delete;
};
// WinRT app-owned enumeration can omit containers even immediately after creation
// in an unpackaged desktop helper. Persist exact provider IDs across helper runs.
constexpr auto destinationRegistry = L"Software\\TabMail\\Voice\\Productivity";
std::optional<hstring> savedDestination(const wchar_t* name, const wchar_t* registry = destinationRegistry) {
    std::vector<wchar_t> value(32769);
    DWORD bytes = static_cast<DWORD>(value.size() * sizeof(wchar_t));
    const auto status = RegGetValueW(HKEY_CURRENT_USER, registry, name,
        RRF_RT_REG_SZ | RRF_ZEROONFAILURE, nullptr, value.data(), &bytes);
    if (status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND) return std::nullopt;
    if (status != ERROR_SUCCESS || bytes < 2 * sizeof(wchar_t) || bytes % sizeof(wchar_t) != 0 || bytes > value.size() * sizeof(wchar_t))
        throw std::runtime_error("invalid saved destination");
    const auto length = bytes / sizeof(wchar_t) - 1;
    if (value[length] != L'\0' || std::find(value.begin(), value.begin() + length, L'\0') != value.begin() + length)
        throw std::runtime_error("invalid saved destination");
    return hstring(value.data(), static_cast<uint32_t>(length));
}
void saveDestination(const wchar_t* name, hstring const& id, const wchar_t* registry = destinationRegistry) {
    if (id.empty() || id.size() > 32768 || std::wstring_view(id).find(L'\0') != std::wstring_view::npos)
        throw std::runtime_error("invalid destination ID");
    const auto bytes = static_cast<DWORD>((id.size() + 1) * sizeof(wchar_t));
    if (RegSetKeyValueW(HKEY_CURRENT_USER, registry, name, REG_SZ, id.c_str(), bytes) != ERROR_SUCCESS)
        throw std::runtime_error("cannot save destination");
}
JSON saveContact(ContactList const& destination, Contact const& contact) {
    awaitProvider(destination.SaveContactAsync(contact));
    return card(awaitProvider(destination.GetContactAsync(contact.Id())));
}
JSON add(const JSON& input, const wchar_t* registry = destinationRegistry) {
    auto contact = draft(input); // Validate everything before any store mutation.
    WriteLock lock;
    auto store = awaitProvider(ContactManager::RequestStoreAsync(ContactStoreAccessType::AppContactsReadWrite));
    if (!store) throw std::runtime_error("no store");
    if (auto id = savedDestination(L"ContactListID", registry)) {
        const auto destination = awaitProvider(store.GetContactListAsync(*id));
        if (!destination) throw std::runtime_error("saved contacts destination unavailable");
        return saveContact(destination, contact);
    }
    auto lists = awaitProvider(store.FindContactListsAsync());
    if (lists.Size() > 32) throw std::runtime_error("too many lists");
    ContactList destination{nullptr};
    for (auto const& list : lists) if (list.DisplayName() == L"TabMail Voice") {
        if (destination) throw std::runtime_error("ambiguous destination");
        destination = list;
    }
    const bool created = !destination;
    if (created) destination = awaitProvider(store.CreateContactListAsync(L"TabMail Voice"));
    try { saveDestination(L"ContactListID", destination.Id(), registry); }
    catch (...) { if (created) { try { awaitProvider(destination.DeleteAsync()); } catch (...) {} } throw; }
    return saveContact(destination, contact);
}
// The provider owns recurrence expansion and OS calendar storage. The wire
// contract remains the common millisecond EventStore contract.
namespace appointments = Windows::ApplicationModel::Appointments;
constexpr int64_t windowsEpochMilliseconds = 11644473600000LL;
int64_t eventMilliseconds(const JSON& input, const char* key) {
    const auto& value = input.at(key);
    if (!value.is_number_integer() || value < -2208988800000LL || value > 253402300799000LL)
        throw std::runtime_error("invalid date");
    return value.get<int64_t>();
}
Windows::Foundation::DateTime eventTime(int64_t milliseconds) {
    return Windows::Foundation::DateTime{Windows::Foundation::TimeSpan{(milliseconds + windowsEpochMilliseconds) * 10000}};
}
int64_t eventMilliseconds(Windows::Foundation::DateTime time) {
    const auto value = std::chrono::duration_cast<std::chrono::milliseconds>(time.time_since_epoch()).count() - windowsEpochMilliseconds;
    return eventMilliseconds(JSON{{"date", value}}, "date");
}
// All-day wire dates name inclusive local days; WinRT stores an exclusive end.
// Shift the wall-calendar date before converting back through the OS time zone.
int64_t shiftLocalDay(int64_t milliseconds, int days, const DYNAMIC_TIME_ZONE_INFORMATION* zone = nullptr) {
    DYNAMIC_TIME_ZONE_INFORMATION current{};
    if (!zone) {
        if (GetDynamicTimeZoneInformation(&current) == TIME_ZONE_ID_INVALID) throw std::runtime_error("no time zone");
        zone = &current;
    }
    const auto ticks = static_cast<uint64_t>((milliseconds + windowsEpochMilliseconds) * 10000);
    ULARGE_INTEGER encoded{}; encoded.QuadPart = ticks;
    FILETIME utcFile{encoded.LowPart, encoded.HighPart};
    SYSTEMTIME utc{}, local{};
    if (!FileTimeToSystemTime(&utcFile, &utc) || !SystemTimeToTzSpecificLocalTimeEx(zone, &utc, &local))
        throw std::runtime_error("invalid local date");
    FILETIME wallFile{};
    if (!SystemTimeToFileTime(&local, &wallFile)) throw std::runtime_error("invalid local date");
    encoded.LowPart = wallFile.dwLowDateTime; encoded.HighPart = wallFile.dwHighDateTime;
    const auto shifted = static_cast<int64_t>(encoded.QuadPart) + static_cast<int64_t>(days) * 864000000000LL;
    if (shifted < 0) throw std::runtime_error("invalid local date");
    encoded.QuadPart = static_cast<uint64_t>(shifted);
    wallFile = FILETIME{encoded.LowPart, encoded.HighPart};
    if (!FileTimeToSystemTime(&wallFile, &local) || !TzSpecificLocalTimeToSystemTimeEx(zone, &local, &utc)
        || !SystemTimeToFileTime(&utc, &utcFile)) throw std::runtime_error("invalid local date");
    encoded.LowPart = utcFile.dwLowDateTime; encoded.HighPart = utcFile.dwHighDateTime;
    const auto result = static_cast<int64_t>(encoded.QuadPart / 10000) - windowsEpochMilliseconds;
    return eventMilliseconds(JSON{{"date", result}}, "date");
}
appointments::Appointment eventDraft(const JSON& input) {
    const auto start = eventMilliseconds(input, "start"), end = eventMilliseconds(input, "end");
    if (end < start || !input.at("isAllDay").is_boolean()) throw std::runtime_error("invalid event");
    const auto title = text(input, "title");
    if (title.empty()) throw std::runtime_error("empty title");
    const auto location = input.at("location").is_null() ? std::string{} : text(input, "location");
    const auto notes = input.at("notes").is_null() ? std::string{} : text(input, "notes");
    appointments::Appointment result;
    result.Subject(to_hstring(title)); result.StartTime(eventTime(start));
    const auto storedEnd = input.at("isAllDay").get<bool>() ? shiftLocalDay(end, 1) : end;
    result.Duration(std::chrono::milliseconds(storedEnd - start));
    result.AllDay(input.at("isAllDay").get<bool>());
    result.Location(to_hstring(location)); result.Details(to_hstring(notes));
    result.DetailsKind(appointments::AppointmentDetailsKind::PlainText);
    return result;
}
JSON eventCard(appointments::Appointment const& event, const std::string& calendar) {
    if (!event || event.Duration().count() < 0) throw std::runtime_error("invalid event");
    const auto start = eventMilliseconds(event.StartTime());
    const auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(event.Duration()).count();
    if (duration > 253402300799000LL - start) throw std::runtime_error("invalid duration");
    const auto end = event.AllDay() ? shiftLocalDay(start + duration, -1) : start + duration;
    if (end < start) throw std::runtime_error("invalid all-day duration");
    const auto location = field(event.Location()), notes = field(event.Details());
    return {{"title", field(event.Subject())}, {"calendar", calendar}, {"start", start}, {"end", end},
        {"isAllDay", event.AllDay()}, {"location", location.empty() ? JSON(nullptr) : JSON(location)},
        {"notes", notes.empty() ? JSON(nullptr) : JSON(notes)}};
}
JSON calendarEvents(const JSON& input) {
    const auto start = eventMilliseconds(input, "start"), end = eventMilliseconds(input, "end");
    if (end <= start) throw std::runtime_error("invalid range");
    auto store = awaitProvider(appointments::AppointmentManager::RequestStoreAsync(appointments::AppointmentStoreAccessType::AllCalendarsReadOnly));
    if (!store) throw std::runtime_error("no store");
    appointments::FindAppointmentsOptions options;
    options.MaxCount(1001);
    for (auto const& property : {appointments::AppointmentProperties::Subject(), appointments::AppointmentProperties::StartTime(),
         appointments::AppointmentProperties::Duration(), appointments::AppointmentProperties::AllDay(), appointments::AppointmentProperties::Location(),
         appointments::AppointmentProperties::Details()}) options.FetchProperties().Append(property);
    auto events = awaitProvider(store.FindAppointmentsAsync(eventTime(start), std::chrono::milliseconds(end - start), options));
    if (events.Size() > 1000) throw std::runtime_error("too many events");
    JSON result = JSON::array(); size_t bytes = 0;
    std::map<std::string, std::string> names;
    for (auto const& event : events) {
        const auto id = field(event.CalendarId());
        if (!names.contains(id)) {
            auto calendar = awaitProvider(store.GetAppointmentCalendarAsync(event.CalendarId()));
            if (!calendar) throw std::runtime_error("missing calendar");
            names.emplace(id, field(calendar.DisplayName()));
        }
        auto row = eventCard(event, names.at(id)); bytes += row.dump().size();
        if (bytes > 512 * 1024) throw std::runtime_error("results too large");
        result.push_back(std::move(row));
    }
    return result;
}
JSON saveEvent(appointments::AppointmentCalendar const& destination, appointments::Appointment const& event) {
    awaitProvider(destination.SaveAppointmentAsync(event));
    return eventCard(awaitProvider(destination.GetAppointmentAsync(event.LocalId())), field(destination.DisplayName()));
}
JSON calendarAdd(const JSON& input, const wchar_t* registry = destinationRegistry) {
    auto event = eventDraft(input); // No mutations until the entire draft validates.
    WriteLock lock;
    auto store = awaitProvider(appointments::AppointmentManager::RequestStoreAsync(appointments::AppointmentStoreAccessType::AppCalendarsReadWrite));
    if (!store) throw std::runtime_error("no store");
    if (auto id = savedDestination(L"CalendarID", registry)) {
        const auto destination = awaitProvider(store.GetAppointmentCalendarAsync(*id));
        if (!destination) throw std::runtime_error("saved calendar destination unavailable");
        return saveEvent(destination, event);
    }
    auto calendars = awaitProvider(store.FindAppointmentCalendarsAsync());
    if (calendars.Size() > 32) throw std::runtime_error("too many calendars");
    appointments::AppointmentCalendar destination{nullptr};
    for (auto const& calendar : calendars) if (calendar.DisplayName() == L"TabMail Voice") {
        if (destination) throw std::runtime_error("ambiguous destination");
        destination = calendar;
    }
    const bool created = !destination;
    if (created) destination = awaitProvider(store.CreateAppointmentCalendarAsync(L"TabMail Voice"));
    try { saveDestination(L"CalendarID", destination.LocalId(), registry); }
    catch (...) { if (created) { try { awaitProvider(destination.DeleteAsync()); } catch (...) {} } throw; }
    return saveEvent(destination, event);
}
JSON run(const JSON& request) {
    const auto method = text(request, "method");
    if (method == "calendarEvents") return calendarEvents(request.at("params"));
    if (method == "calendarAdd") return calendarAdd(request.at("params"));
    if (method == "contactsSearch") return search(request.at("params"));
    if (method == "contactsAdd") return add(request.at("params"));
    throw std::runtime_error("unsupported operation");
}
}
int main() {
    return voice_productivity::serve([](const JSON& request) {
        init_apartment(apartment_type::multi_threaded);
        return run(request);
    });
}
