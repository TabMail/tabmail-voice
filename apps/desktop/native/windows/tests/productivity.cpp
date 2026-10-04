// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#define main productivity_entry
#include "../src/productivity.cpp"
#undef main

void require(bool value) { if (!value) throw std::runtime_error("contact contract failed"); }
// Isolated synthetic registry key; never touches the production destination IDs.
void destinationContracts() {
    const auto path = L"Software\\TabMail\\Voice\\SyntheticRegistryContract\\" +
        std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
    HKEY key{}; DWORD disposition{};
    require(RegCreateKeyExW(HKEY_CURRENT_USER, path.c_str(), 0, nullptr, 0,
        KEY_SET_VALUE, nullptr, &key, &disposition) == ERROR_SUCCESS);
    RegCloseKey(key);
    require(disposition == REG_CREATED_NEW_KEY);
    struct Cleanup { const wchar_t* path; ~Cleanup() { RegDeleteTreeW(HKEY_CURRENT_USER, path); } } cleanup{path.c_str()};
    require(!savedDestination(L"ID", path.c_str()));
    saveDestination(L"ID", L"synthetic-provider-id", path.c_str());
    require(savedDestination(L"ID", path.c_str()) == hstring(L"synthetic-provider-id"));
    saveDestination(L"ID", L"replacement-id", path.c_str());
    require(savedDestination(L"ID", path.c_str()) == hstring(L"replacement-id"));
    auto refused = [&](auto action) { bool rejected = false; try { action(); } catch (...) { rejected = true; } require(rejected); };
    refused([&] { saveDestination(L"ID", L"", path.c_str()); });
    refused([&] { saveDestination(L"ID", hstring(std::wstring(32769, L'x')), path.c_str()); });
    const wchar_t embedded[] = {L'a', 0, L'b', 0};
    refused([&] { saveDestination(L"ID", hstring(embedded, 3), path.c_str()); });
    require(savedDestination(L"ID", path.c_str()) == hstring(L"replacement-id"));
    auto raw = [&](DWORD type, const void* data, DWORD bytes) {
        require(RegSetKeyValueW(HKEY_CURRENT_USER, path.c_str(), L"ID", type, data, bytes) == ERROR_SUCCESS);
        refused([&] { (void)savedDestination(L"ID", path.c_str()); });
    };
    const DWORD number = 7;
    raw(REG_DWORD, &number, sizeof(number));
    raw(REG_SZ, L"", sizeof(wchar_t));
    raw(REG_SZ, embedded, sizeof(embedded));
    const std::wstring oversized(32769, L'x');
    raw(REG_SZ, oversized.c_str(), static_cast<DWORD>((oversized.size() + 1) * sizeof(wchar_t)));
    require(RegDeleteTreeW(HKEY_CURRENT_USER, path.c_str()) == ERROR_SUCCESS);
    require(!savedDestination(L"ID", path.c_str()));
}
int main() {
    try {
        init_apartment(apartment_type::multi_threaded);
        destinationContracts();
        JSON valid{{"firstName", "Ren\xC3\xA9" "e"}, {"lastName", "Synthetic"}, {"organization", "Test Company"},
            {"emails", JSON::array({"synthetic@example.invalid"})}, {"phones", JSON::array({"+1 555 0100"})}};
        require(card(draft(valid)) == valid);
        for (auto invalid : {JSON(nullptr), JSON::object(), JSON{{"method", "unknown"}, {"params", JSON::object()}}}) {
            bool refused = false; try { (void)run(invalid); } catch (...) { refused = true; } require(refused);
        }
        for (const auto* key : {"firstName", "lastName", "organization"}) {
            auto invalid = valid; invalid[key] = std::string("x\0y", 3);
            bool refused = false; try { (void)draft(invalid); } catch (...) { refused = true; } require(refused);
        }
        auto invalid = valid; invalid["emails"] = JSON::array({"a", "b"});
        bool refused = false; try { (void)draft(invalid); } catch (...) { refused = true; } require(refused);
        invalid = valid; invalid["firstName"] = std::string(32769, 'x');
        refused = false; try { (void)draft(invalid); } catch (...) { refused = true; } require(refused);
        for (JSON limit : {JSON(0), JSON(101), JSON(1.5), JSON("1")}) {
            refused = false; try { (void)search(JSON{{"query", "synthetic"}, {"limit", limit}}); } catch (...) { refused = true; } require(refused);
        }
        JSON event{{"title", "Synthetic event"}, {"start", 1780333200123LL}, {"end", 1780336800123LL},
            {"isAllDay", false}, {"location", "Synthetic location"}, {"notes", "Synthetic notes"}};
        auto expected = event; expected["calendar"] = "Synthetic calendar";
        require(eventCard(eventDraft(event), "Synthetic calendar") == expected);
        for (int64_t date : {-2208988800000LL, 0LL, 253402300799000LL}) require(eventMilliseconds(eventTime(date)) == date);
        for (JSON date : {JSON(-2208988800001LL), JSON(253402300799001LL), JSON(1.5), JSON("0"), JSON(nullptr)}) {
            auto bad = event; bad["start"] = date;
            refused = false; try { (void)eventDraft(bad); } catch (...) { refused = true; } require(refused);
        }
        for (auto key : {"title", "location", "notes"}) {
            auto bad = event; bad[key] = std::string("a\0b", 3);
            refused = false; try { (void)eventDraft(bad); } catch (...) { refused = true; } require(refused);
        }
        auto bad = event; bad["end"] = bad["start"].get<int64_t>() - 1;
        refused = false; try { (void)eventDraft(bad); } catch (...) { refused = true; } require(refused);
        bad = event; bad["isAllDay"] = 1;
        refused = false; try { (void)eventDraft(bad); } catch (...) { refused = true; } require(refused);
        auto allDay = event; allDay["start"] = 1780272000000LL; allDay["end"] = 1780358400000LL; allDay["isAllDay"] = true;
        allDay["location"] = nullptr; allDay["notes"] = nullptr;
        expected = allDay; expected["calendar"] = "Synthetic calendar";
        require(eventCard(eventDraft(allDay), "Synthetic calendar") == expected);
        auto singleDay = allDay; singleDay["end"] = singleDay["start"];
        expected = singleDay; expected["calendar"] = "Synthetic calendar";
        auto storedDay = eventDraft(singleDay);
        require(storedDay.Duration() > std::chrono::hours(0));
        require(eventCard(storedDay, "Synthetic calendar") == expected);
        DYNAMIC_TIME_ZONE_INFORMATION pacific{};
        bool foundPacific = false;
        for (DWORD index = 0; index < 1024; ++index) {
            const auto status = EnumDynamicTimeZoneInformation(index, &pacific);
            if (status == ERROR_NO_MORE_ITEMS) break;
            require(status == ERROR_SUCCESS);
            if (std::wstring_view(pacific.TimeZoneKeyName) == L"Pacific Standard Time") { foundPacific = true; break; }
        }
        require(foundPacific);
        // 23/25-hour local days and pre-2007 US DST rules, without changing OS settings.
        require(shiftLocalDay(1805011200000LL, 1, &pacific) == 1805094000000LL);
        require(shiftLocalDay(1805094000000LL, -1, &pacific) == 1805011200000LL);
        require(shiftLocalDay(1825570800000LL, 1, &pacific) == 1825660800000LL);
        require(shiftLocalDay(1825660800000LL, -1, &pacific) == 1825570800000LL);
        require(shiftLocalDay(1142150400000LL, 1, &pacific) == 1142236800000LL);
        require(shiftLocalDay(1142236800000LL, -1, &pacific) == 1142150400000LL);
        require(shiftLocalDay(1143964800000LL, 1, &pacific) == 1144047600000LL);
        require(shiftLocalDay(1144047600000LL, -1, &pacific) == 1143964800000LL);
        std::cout << "WINDOWS_PRODUCTIVITY_CONTRACT_PASS contacts and calendar\n";
    } catch (...) { return 1; }
}
