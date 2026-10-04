// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Opt-in disposable-VM test: only uniquely named containers created here are removed.
#define main productivity_entry
#include "../src/productivity.cpp"
#undef main
#include <objbase.h>
#include <filesystem>
#include <fstream>

int wmain(int argc, wchar_t** argv) {
    if (argc != 3) return 2;
    const std::filesystem::path manifest = argv[2];
    try {
        init_apartment(apartment_type::multi_threaded);
        auto contacts = awaitProvider(ContactManager::RequestStoreAsync(ContactStoreAccessType::AppContactsReadWrite));
        auto calendars = awaitProvider(appointments::AppointmentManager::RequestStoreAsync(appointments::AppointmentStoreAccessType::AppCalendarsReadWrite));
        if (!contacts || !calendars) throw std::runtime_error("store unavailable");
        if (std::wstring_view(argv[1]) == L"--check-owned") {
            std::ifstream input(manifest);
            const auto owned = JSON::parse(input);
            const auto registry = to_hstring(owned.at("registry").get<std::string>());
            const auto savedContact = savedDestination(L"ContactListID", registry.c_str());
            const auto savedCalendar = savedDestination(L"CalendarID", registry.c_str());
            const bool persisted = savedContact && savedCalendar && to_string(*savedContact) == owned.at("contactID").get<std::string>() && to_string(*savedCalendar) == owned.at("calendarID").get<std::string>();
            bool contactFound = false, calendarFound = false;
            for (auto const& list : awaitProvider(contacts.FindContactListsAsync()))
                if (to_string(list.Id()) == owned.at("contactID").get<std::string>() && to_string(list.DisplayName()) == owned.at("name").get<std::string>()) contactFound = true;
            for (auto const& calendar : awaitProvider(calendars.FindAppointmentCalendarsAsync()))
                if (to_string(calendar.LocalId()) == owned.at("calendarID").get<std::string>() && to_string(calendar.DisplayName()) == owned.at("name").get<std::string>()) calendarFound = true;
            JSON observation{{"contactsVisible", contactFound}, {"calendarVisible", calendarFound}, {"persistedIDs", persisted}};
            try {
                const auto list = awaitProvider(contacts.GetContactListAsync(to_hstring(owned.at("contactID").get<std::string>())));
                observation["directContact"] = list && to_string(list.DisplayName()) == owned.at("name").get<std::string>();
                if (observation["directContact"].get<bool>()) {
                    JSON synthetic{{"firstName", "Synthetic"}, {"lastName", "Identity"}, {"organization", ""}, {"emails", JSON::array({"identity@example.invalid"})}, {"phones", JSON::array()}};
                    observation["contactWriteReadback"] = add(synthetic, registry.c_str()) == synthetic;
                }
            } catch (hresult_error const& error) { observation["directContactError"] = static_cast<uint32_t>(error.code().value); }
            try {
                const auto item = awaitProvider(calendars.GetAppointmentCalendarAsync(to_hstring(owned.at("calendarID").get<std::string>())));
                observation["directCalendar"] = item && to_string(item.DisplayName()) == owned.at("name").get<std::string>();
                if (observation["directCalendar"].get<bool>()) {
                    JSON synthetic{{"title", "Synthetic identity"}, {"start", 1810036800000LL}, {"end", 1810040400000LL}, {"isAllDay", false}, {"location", nullptr}, {"notes", nullptr}};
                    auto expected = synthetic; expected["calendar"] = owned.at("name");
                    observation["calendarWriteReadback"] = calendarAdd(synthetic, registry.c_str()) == expected;
                }
            } catch (hresult_error const& error) { observation["directCalendarError"] = static_cast<uint32_t>(error.code().value); }
            std::ofstream(manifest.string() + ".relocated.json") << observation.dump();
            return persisted && observation.value("contactWriteReadback", false) && observation.value("calendarWriteReadback", false) ? 0 : 1;
        }
        if (std::wstring_view(argv[1]) != L"--synthetic-store") return 2;
        GUID guid{};
        if (FAILED(CoCreateGuid(&guid))) return 3;
        wchar_t guidText[40]{};
        if (!StringFromGUID2(guid, guidText, 40)) return 3;
        const auto name = L"TabMail Synthetic Identity " + std::wstring(guidText);
        const auto registry = L"Software\\TabMail\\Voice\\SyntheticIdentity\\" + std::wstring(guidText);
        ContactList contactList{nullptr};
        appointments::AppointmentCalendar calendar{nullptr};
        bool passed = false;
        JSON evidence = JSON::object();
        const auto relocated = manifest.parent_path() / (L"relocated-" + std::wstring(guidText));
        try {
            contactList = awaitProvider(contacts.CreateContactListAsync(name));
            calendar = awaitProvider(calendars.CreateAppointmentCalendarAsync(name));
            saveDestination(L"ContactListID", contactList.Id(), registry.c_str());
            saveDestination(L"CalendarID", calendar.LocalId(), registry.c_str());
            // Persist exact owned IDs before spawning. Keep this evidence local to the VM.
            std::ofstream(manifest) << JSON{{"registry", to_string(registry)}, {"name", to_string(name)}, {"contactID", to_string(contactList.Id())}, {"calendarID", to_string(calendar.LocalId())}}.dump();
            std::filesystem::create_directory(relocated);
            const auto copy = relocated / L"voice-provider-identity-tests.exe";
            std::filesystem::copy_file(std::filesystem::absolute(argv[0]), copy);
            auto check = [&](const std::filesystem::path& executable) {
                std::wstring command = L"\"" + executable.wstring() + L"\" --check-owned \"" + manifest.wstring() + L"\"";
                STARTUPINFOW startup{}; startup.cb = sizeof(startup);
                PROCESS_INFORMATION process{};
                if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, executable.parent_path().c_str(), &startup, &process))
                    throw std::runtime_error("child launch");
                CloseHandle(process.hThread);
                const auto wait = WaitForSingleObject(process.hProcess, 60000);
                DWORD exitCode = 1;
                if (wait != WAIT_OBJECT_0) { TerminateProcess(process.hProcess, 1); WaitForSingleObject(process.hProcess, 10000); }
                else GetExitCodeProcess(process.hProcess, &exitCode);
                CloseHandle(process.hProcess);
                return wait == WAIT_OBJECT_0 && exitCode == 0;
            };
            bool ownContact = false, ownCalendar = false;
            for (auto const& item : awaitProvider(contacts.FindContactListsAsync())) if (item.Id() == contactList.Id()) ownContact = true;
            for (auto const& item : awaitProvider(calendars.FindAppointmentCalendarsAsync())) if (item.LocalId() == calendar.LocalId()) ownCalendar = true;
            evidence["creatorContactEnumeration"] = ownContact;
            evidence["creatorCalendarEnumeration"] = ownCalendar;
            const bool samePath = check(std::filesystem::absolute(argv[0]));
            evidence["samePathIdentity"] = samePath;
            { std::ifstream details(manifest.string() + ".relocated.json"); if (details) evidence["samePathDetails"] = JSON::parse(details); }
            const bool moved = check(copy);
            evidence["relocatedIdentity"] = moved;
            { std::ifstream details(manifest.string() + ".relocated.json"); if (details) evidence["relocatedDetails"] = JSON::parse(details); }
            passed = samePath && moved;
        } catch (hresult_error const& error) { evidence["providerError"] = static_cast<uint32_t>(error.code().value); }
          catch (...) { evidence["fixtureError"] = true; }
        bool cleaned = true;
        if (calendar) try {
            const auto id = calendar.LocalId(); awaitProvider(calendar.DeleteAsync());
            if (awaitProvider(calendars.GetAppointmentCalendarAsync(id))) cleaned = false;
        } catch (...) { cleaned = false; }
        if (contactList) try {
            const auto id = contactList.Id(); awaitProvider(contactList.DeleteAsync());
            if (awaitProvider(contacts.GetContactListAsync(id))) cleaned = false;
        } catch (...) { cleaned = false; }
        const auto registryCleanup = RegDeleteTreeW(HKEY_CURRENT_USER, registry.c_str());
        evidence["syntheticRegistryCleanup"] = registryCleanup == ERROR_SUCCESS || registryCleanup == ERROR_FILE_NOT_FOUND;
        cleaned = cleaned && evidence["syntheticRegistryCleanup"].get<bool>();
        evidence["exactOwnedCleanup"] = cleaned;
        std::ofstream(manifest.string() + ".result.json") << evidence.dump();
        std::error_code ignored;
        std::filesystem::remove_all(relocated, ignored);
        return passed && cleaned ? 0 : 1;
    } catch (hresult_error const& error) {
        std::ofstream(manifest.string() + ".result.json") << JSON{{"startupProviderError", static_cast<uint32_t>(error.code().value)}}.dump();
        return 3;
    } catch (...) {
        std::ofstream(manifest.string() + ".result.json") << JSON{{"startupError", true}}.dump();
        return 3;
    }
}
