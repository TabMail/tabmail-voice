// Opt-in real provider test. Creates and deletes only a uniquely named synthetic calendar.
// Run in the disposable, logged-in test VM: executable --synthetic-store evidence.jsonl
#define main productivity_entry
#include "../src/productivity.cpp"
#undef main
#include <fstream>
#include <filesystem>
int main(int argc, char** argv) {
 if(argc!=3 || std::string_view(argv[1])!="--synthetic-store")return 2;
 const std::filesystem::path evidence=argv[2];
 std::ofstream out(evidence);
 if(!out)return 2;
 auto report=[&](char const* stage,bool ok){out << JSON{{"stage",stage},{"ok",ok}}.dump() << std::endl;};
 appointments::AppointmentCalendar calendar{nullptr}; bool passed=true;
 try {
  init_apartment(apartment_type::multi_threaded);
  auto store=awaitProvider(appointments::AppointmentManager::RequestStoreAsync(appointments::AppointmentStoreAccessType::AppCalendarsReadWrite));
  const auto key="VoiceCalendarProbe"+std::to_string(GetCurrentProcessId());
  const auto name="TabMail Synthetic "+key;
  calendar=awaitProvider(store.CreateAppointmentCalendarAsync(to_hstring(name)));
  std::ofstream(evidence.string()+".owned-id") << to_string(calendar.LocalId());
  const int64_t start=1810036800123LL;
  JSON input{{"title",key},{"start",start},{"end",start+3600000},{"isAllDay",false},{"location","Synthetic location"},{"notes","Synthetic notes"}};
  auto expected=input;expected["calendar"]=name;expected["start"]=start-start%1000;expected["end"]=start-start%1000+3600000;
  auto row=saveEvent(calendar,eventDraft(input));
  out << JSON{{"syntheticSaved",row},{"expected",expected}}.dump()<<std::endl;
  bool ok=row==expected;report("production-save-readback",ok);passed&=ok;
  auto select=[&](int64_t from,int64_t to,const std::string& title){JSON selected=JSON::array();for(auto const& event:calendarEvents(JSON{{"start",from},{"end",to}}))if(event.at("title")==title && event.at("calendar")==name)selected.push_back(event);return selected;};
  auto rows=select(start-1,start+7200000,key);ok=rows.size()==1 && rows[0]==expected;report("production-range-read",ok);passed&=ok;
  rows=select(start+1800000,start+1800001,key);ok=rows.size()==1;report("overlapping-range",ok);passed&=ok;
  rows=select(start+3600000,start+7200000,key);ok=rows.empty();report("exclusive-end-boundary",ok);passed&=ok;
  SYSTEMTIME local{};local.wYear=2027;local.wMonth=5;local.wDay=12;
  SYSTEMTIME utc{};FILETIME fileTime{};
  if(!TzSpecificLocalTimeToSystemTime(nullptr,&local,&utc)||!SystemTimeToFileTime(&utc,&fileTime))throw std::runtime_error("synthetic local midnight");
  ULARGE_INTEGER ticks{};ticks.LowPart=fileTime.dwLowDateTime;ticks.HighPart=fileTime.dwHighDateTime;
  const int64_t midnight=static_cast<int64_t>(ticks.QuadPart/10000)-windowsEpochMilliseconds;
  auto allDay=input;allDay["title"]=key+"AllDay";allDay["start"]=midnight;allDay["end"]=midnight+86400000;allDay["isAllDay"]=true;allDay["location"]=nullptr;allDay["notes"]=nullptr;
  auto allExpected=allDay;allExpected["calendar"]=name;
  row=saveEvent(calendar,eventDraft(allDay));out << JSON{{"syntheticAllDay",row},{"expected",allExpected}}.dump()<<std::endl;ok=row==allExpected;report("all-day-save-readback",ok);passed&=ok;
  rows=select(midnight,midnight+86400000,key+"AllDay");ok=rows.size()==1 && rows[0]==allExpected;report("all-day-range",ok);passed&=ok;
  auto recurring=input;recurring["title"]=key+"Recurring";
  auto appointment=eventDraft(recurring);appointments::AppointmentRecurrence recurrence;
  recurrence.Unit(appointments::AppointmentRecurrenceUnit::Daily);recurrence.Interval(1);recurrence.Occurrences(3);appointment.Recurrence(recurrence);
  (void)saveEvent(calendar,appointment);
  rows=select(start-1,start+3*86400000LL,key+"Recurring");
  out << JSON{{"syntheticRecurrences",rows}}.dump()<<std::endl;
  ok=rows.size()==3;
  if(ok)for(size_t i=0;i<3;i++)ok&=rows[i].at("start")==start-start%1000+static_cast<int64_t>(i)*86400000LL;
  report("recurrence-expanded",ok);passed&=ok;
 } catch(hresult_error const& e) {out << JSON{{"stage","provider-error"},{"code",static_cast<uint32_t>(e.code().value)}}.dump()<<std::endl;passed=false;}
 catch(...) {report("contract-error",false);passed=false;}
 if(calendar)try {
  const auto id=calendar.LocalId();awaitProvider(calendar.DeleteAsync());
  auto store=awaitProvider(appointments::AppointmentManager::RequestStoreAsync(appointments::AppointmentStoreAccessType::AppCalendarsReadWrite));
  bool absent=true;for(auto const& item:awaitProvider(store.FindAppointmentCalendarsAsync()))absent&=item.LocalId()!=id;
  report("exact-owned-calendar-cleanup",absent);passed&=absent;
 }catch(...){report("cleanup",false);passed=false;}
 return passed?0:1;
}
