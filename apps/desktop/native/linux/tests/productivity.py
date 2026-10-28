# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Exercise the real EDS local provider, in disposable stores and a private bus."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

if sys.argv[-1] != "--session":
    with tempfile.TemporaryDirectory(prefix='voice-productivity-') as root:
        env = dict(os.environ)
        for key, child in [('HOME','home'), ('XDG_DATA_HOME','data'), ('XDG_CONFIG_HOME','config'),
                           ('XDG_CACHE_HOME','cache'), ('XDG_RUNTIME_DIR','runtime')]:
            directory = Path(root, child)
            directory.mkdir(mode=0o700)
            env[key] = str(directory)
        for key in ['DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY']:
            env.pop(key, None)
        env['GIO_USE_VFS'] = 'local'
        sys.exit(subprocess.call(['dbus-run-session', '--', sys.executable, __file__, *sys.argv[1:], '--session'], env=env))

executable = sys.argv[1]
def call(method, params, succeeds=True):
    result = subprocess.run([executable], input=json.dumps({'method':method, 'params':params})+'\n',
                            text=True, capture_output=True, timeout=20)
    if not succeeds:
        assert result.returncode != 0, result.stdout
        assert result.stdout == ''
        assert result.stderr.strip() == 'productivity request failed'
        return
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)

def contact(first, email):
    return dict(firstName=first, lastName='Synthetic', organization='Voice Test', emails=[email], phones=['+1 555 0100'])

first = contact('Renée', 'renee@example.invalid')
assert call('contactsAdd', first) == first
second = contact('Second', 'second@example.invalid')
assert call('contactsAdd', second) == second
assert call('contactsSearch', {'query':'Renée', 'limit':10}) == [first]
assert call('contactsSearch', {'query':'renee', 'limit':10}) == [first]
assert call('contactsSearch', {'query':'renee@example.invalid', 'limit':10}) == [first]
assert len(call('contactsSearch', {'query':'Synthetic', 'limit':1})) == 1
assert len(call('contactsSearch', {'query':'Voice Test', 'limit':10})) == 2
assert call('contactsSearch', {'query':'") (contains "full_name" "', 'limit':10}) == []
for query in ['', 'x'*32769, 'x\0y']:
    call('contactsSearch', {'query':query, 'limit':10}, False)
for limit in [0, -1, 101, 1.5]:
    call('contactsSearch', {'query':'Synthetic', 'limit':limit}, False)
invalid = contact('Rejected', 'rejected@example.invalid')
invalid['phones'].append('second phone')
call('contactsAdd', invalid, False)
assert call('contactsSearch', {'query':'Rejected', 'limit':10}) == []
print('EDS contact create, search, bounds and query escaping passed')

saved = call('notesAdd', {'title':'Synthetic memo', 'text':'Unicode café\n<literal> & text'})
assert saved['title'] == 'Synthetic memo' and saved['folder']
notes = call('notesSearch', {'query':'Synthetic memo'})
assert len(notes) == 1 and notes[0]['title'] == saved['title']
assert notes[0]['text'] == 'Unicode café\n<literal> & text'
assert notes[0]['folder'] == saved['folder']
assert len(call('notesSearch', {'query':'literal'})) == 1
assert call('notesSearch', {'query':'") (contains? "summary" "'}) == []
call('notesAdd', {'title':'Rejected memo', 'text':'x'*32769}, False)
assert call('notesSearch', {'query':'Rejected memo'}) == []
call('notesSearch', {'query':''}, False)
print('EDS memo create, bounded search and query escaping passed')

import datetime
base = int(datetime.datetime(2026, 10, 3, 14, 30, tzinfo=datetime.timezone.utc).timestamp()*1000)
for title, due, has_time in [('Undated task', None, False), ('Timed task', base, True), ('Day task', base, False)]:
    saved = call('reminderAdd', {'title':title, 'due':due, 'dueHasTime':has_time, 'notes':'Synthetic task notes'})
    assert saved['title'] == title and saved['dueHasTime'] == has_time
    assert saved['notes'] == 'Synthetic task notes' and saved['list']
    if due is None: assert saved['due'] is None
    elif has_time: assert saved['due'] == due
    else:
        local = datetime.datetime.fromtimestamp(base/1000)
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
        assert saved['due'] == int(midnight.timestamp()*1000)
all_tasks = call('reminders', {'dueBefore':None})
assert {r['title'] for r in all_tasks} == {'Undated task', 'Timed task', 'Day task'}
filtered = call('reminders', {'dueBefore':base})
assert {r['title'] for r in filtered} == {'Day task'}
call('reminderAdd', {'title':'Rejected task', 'due':None, 'dueHasTime':True, 'notes':None}, False)
assert not any(r['title'] == 'Rejected task' for r in call('reminders', {'dueBefore':None}))
print('EDS task create, date-only/timed/undated reads and bounds passed')

# Seed states the create tool intentionally cannot produce: completed and zoned.
import gi
gi.require_version('EDataServer', '1.2')
gi.require_version('ECal', '2.0')
gi.require_version('ICalGLib', '3.0')
from gi.repository import EDataServer, ECal, ICalGLib
registry = EDataServer.SourceRegistry.new_sync(None)
client = ECal.Client.connect_sync(registry.ref_default_task_list(), ECal.ClientSourceType.TASKS, 0xffffffff, None)
for uid, fields in [
    ('completed-task', 'SUMMARY:Completed task\r\nSTATUS:COMPLETED\r\nCOMPLETED:20261003T120000Z'),
    ('zoned-task', 'SUMMARY:Zoned task\r\nDUE;TZID=America/Vancouver:20261003T073000'),
]:
    component = ICalGLib.Component.new_from_string(f'BEGIN:VTODO\r\nUID:{uid}\r\nDTSTAMP:20261003T120000Z\r\n{fields}\r\nEND:VTODO\r\n')
    assert client.create_object_sync(component, ECal.OperationFlags.NONE, None)[0]
tasks = call('reminders', {'dueBefore':None})
assert not any(task['title'] == 'Completed task' for task in tasks)
assert next(task for task in tasks if task['title'] == 'Zoned task')['due'] == base
print('EDS completed-task exclusion and provider timezone resolution passed')

calendar_client = ECal.Client.connect_sync(registry.ref_default_calendar(), ECal.ClientSourceType.EVENTS, 0xffffffff, None)
for title, all_day in [('Timed event', False), ('All-day event', True)]:
    draft = {'title':title, 'start':base, 'end':base+3600000, 'isAllDay':all_day, 'location':'Synthetic room', 'notes':'Synthetic notes'}
    saved = call('calendarAdd', draft)
    assert saved['title'] == title and saved['calendar'] and saved['isAllDay'] == all_day
    assert saved['notes'] == draft['notes'] and saved['location'] == draft['location']
    if not all_day: assert saved['start'] == base and saved['end'] == base+3600000
    else: assert saved['start'] == saved['end']
ok, events = calendar_client.get_object_list_sync('#t', None)
assert ok and len(events) == 2
for event in events:
    if event.get_summary() == 'All-day event':
        assert event.get_dtstart().is_date() and event.get_dtend().is_date()
        assert event.get_dtend().get_day() == event.get_dtstart().get_day()+1
    else:
        assert event.get_dtstart().as_timet()*1000 == base
call('calendarAdd', {'title':'Rejected event', 'start':base, 'end':base-1, 'isAllDay':False, 'location':None, 'notes':None}, False)
assert len(calendar_client.get_object_list_sync('#t', None)[1]) == 2
print('EDS timed/all-day calendar writes and stored exclusive end passed')

precise = call('reminderAdd', {'title':'Minute precision', 'due':base+45999, 'dueHasTime':True, 'notes':None})
assert precise['due'] == base
assert next(row for row in call('reminders', {'dueBefore':None}) if row['title'] == 'Minute precision')['due'] == base
print('EDS reminder creation matches EventKit minute precision')

# Recurrences are expanded by EDS, not an application recurrence implementation.
series = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:recurring-test\r\nSUMMARY:Daily series\r\nDTSTART:20261003T143000Z\r\nDTEND:20261003T153000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE:20261005T143000Z\r\nEND:VEVENT\r\n')
assert calendar_client.create_object_sync(series, ECal.OperationFlags.NONE, None)[0]
rows = call('calendarEvents', {'start':base, 'end':base+3*86400000})
assert [row['start'] for row in rows if row['title'] == 'Daily series'] == [base, base+86400000]
assert call('calendarEvents', {'start':base+10*86400000, 'end':base+11*86400000}) == []
call('calendarEvents', {'start':base, 'end':base}, False)
call('calendarEvents', {'start':base, 'end':base+1462*86400000}, False)
print('EDS recurring expansion, exclusions, empty range and request bounds passed')

for summary, start, end in [('Moved occurrence', '20261004T163000Z', '20261004T173000Z'), ('Moved out of range', '20261104T163000Z', '20261104T173000Z')]:
    detached = ICalGLib.Component.new_from_string(f'BEGIN:VEVENT\r\nUID:recurring-test\r\nSUMMARY:{summary}\r\nRECURRENCE-ID:20261004T143000Z\r\nDTSTART:{start}\r\nDTEND:{end}\r\nEND:VEVENT\r\n')
    assert calendar_client.modify_object_sync(detached, ECal.ObjModType.THIS, ECal.OperationFlags.NONE, None)
    rows = call('calendarEvents', {'start':base, 'end':base+3*86400000})
    assert [row['start'] for row in rows if row['title'] == 'Daily series'] == [base], rows
    moved = [row for row in rows if row['title'] == summary]
    if summary == 'Moved occurrence': assert len(moved) == 1 and moved[0]['start'] == base+86400000+7200000
    else: assert moved == []
print('EDS detached occurrence replacement, including a move outside the interval, passed')

# The UTC offset changes within this daily local-time series.
dst = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:dst-series\r\nSUMMARY:DST series\r\nDTSTART;TZID=America/New_York:20261031T090000\r\nDTEND;TZID=America/New_York:20261031T100000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\n')
assert calendar_client.create_object_sync(dst, ECal.OperationFlags.NONE, None)[0]
start_dst = int(datetime.datetime(2026,10,31,tzinfo=datetime.timezone.utc).timestamp()*1000)
rows = call('calendarEvents', {'start':start_dst, 'end':start_dst+4*86400000})
actual = sorted(row['start'] for row in rows if row['title'] == 'DST series')
from zoneinfo import ZoneInfo
expected = [int(datetime.datetime(2026,10,31,9,tzinfo=ZoneInfo('America/New_York')).timestamp()*1000),
            int(datetime.datetime(2026,11,1,9,tzinfo=ZoneInfo('America/New_York')).timestamp()*1000),
            int(datetime.datetime(2026,11,2,9,tzinfo=ZoneInfo('America/New_York')).timestamp()*1000)]
assert expected[1]-expected[0] == 25*3600000
assert actual == expected, actual
# A cancelled detached occurrence suppresses the corresponding master instance.
cancelled = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:dst-series\r\nSUMMARY:Cancelled occurrence\r\nRECURRENCE-ID;TZID=America/New_York:20261101T090000\r\nDTSTART;TZID=America/New_York:20261101T090000\r\nDTEND;TZID=America/New_York:20261101T100000\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n')
assert calendar_client.modify_object_sync(cancelled, ECal.ObjModType.THIS, ECal.OperationFlags.NONE, None)
rows = call('calendarEvents', {'start':start_dst, 'end':start_dst+4*86400000})
assert sorted(row['start'] for row in rows if row['title'] == 'DST series') == [actual[0], actual[2]], rows
assert not any(row['title'] == 'Cancelled occurrence' for row in rows)
print('EDS recurrence across daylight-saving transition and cancellation passed')

# A hostile recurrence cannot silently return a partial successful calendar.
dense = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:dense-series\r\nSUMMARY:Dense series\r\nDTSTART:20270101T000000Z\r\nDTEND:20270101T000001Z\r\nRRULE:FREQ=SECONDLY;COUNT=1002\r\nEND:VEVENT\r\n')
assert calendar_client.create_object_sync(dense, ECal.OperationFlags.NONE, None)[0]
dense_start = int(datetime.datetime(2027,1,1,tzinfo=datetime.timezone.utc).timestamp()*1000)
call('calendarEvents', {'start':dense_start, 'end':dense_start+3600000}, False)
print('EDS occurrence output cap fails without returning partial results')

# The range anchor and unmodified occurrence are both outside this narrow query.
master = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:range-series\r\nSUMMARY:Original weekly\r\nDTSTART:20261003T143000Z\r\nDTEND:20261003T153000Z\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEND:VEVENT\r\n')
assert calendar_client.create_object_sync(master, ECal.OperationFlags.NONE, None)[0]
change = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:range-series\r\nSUMMARY:Shifted weekly\r\nRECURRENCE-ID;RANGE=THISANDFUTURE:20261003T143000Z\r\nDTSTART:20261004T163000Z\r\nDTEND:20261004T180000Z\r\nEND:VEVENT\r\n')
assert calendar_client.modify_object_sync(change, ECal.ObjModType.THIS, ECal.OperationFlags.NONE, None)
query_start = int(datetime.datetime(2026,10,11,tzinfo=datetime.timezone.utc).timestamp()*1000)
rows = call('calendarEvents', {'start':query_start, 'end':query_start+86400000})
shifted = [r for r in rows if r['title'] == 'Shifted weekly']
assert len(shifted) == 1 and shifted[0]['start'] == query_start+int(16.5*3600000) and shifted[0]['end'] == query_start+18*3600000, rows
exact = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:range-series\r\nSUMMARY:Exact after range\r\nRECURRENCE-ID:20261017T143000Z\r\nDTSTART:20261018T183000Z\r\nDTEND:20261018T193000Z\r\nEND:VEVENT\r\n')
assert calendar_client.modify_object_sync(exact, ECal.ObjModType.THIS, ECal.OperationFlags.NONE, None)
rows = call('calendarEvents', {'start':query_start+7*86400000, 'end':query_start+8*86400000})
assert [r['title'] for r in rows] == ['Exact after range'], rows
cancel = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:range-series\r\nSUMMARY:Cancelled after range\r\nRECURRENCE-ID:20261024T143000Z\r\nDTSTART:20261024T143000Z\r\nDTEND:20261024T153000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n')
assert calendar_client.modify_object_sync(cancel, ECal.ObjModType.THIS, ECal.OperationFlags.NONE, None)
rows = call('calendarEvents', {'start':query_start+14*86400000, 'end':query_start+15*86400000})
assert not any(r['title'] in ['Shifted weekly', 'Cancelled after range', 'Original weekly'] for r in rows), rows
print('EDS RANGE moved-in discovery, duration change, exact precedence and cancellation passed')

master = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:range-dst\r\nSUMMARY:Original DST range\r\nDTSTART;TZID=America/New_York:20261031T090000\r\nDTEND;TZID=America/New_York:20261031T100000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\n')
assert calendar_client.create_object_sync(master, ECal.OperationFlags.NONE, None)[0]
change = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:range-dst\r\nSUMMARY:Shifted DST range\r\nRECURRENCE-ID;TZID=America/New_York;RANGE=THISANDFUTURE:20261031T090000\r\nDTSTART;TZID=America/New_York:20261031T100000\r\nDTEND;TZID=America/New_York:20261031T113000\r\nEND:VEVENT\r\n')
assert calendar_client.modify_object_sync(change, ECal.ObjModType.THIS, ECal.OperationFlags.NONE, None)
rows = call('calendarEvents', {'start':start_dst+86400000, 'end':start_dst+2*86400000})
shifted = [r for r in rows if r['title'] == 'Shifted DST range']
expected_start = int(datetime.datetime(2026,11,1,10,tzinfo=ZoneInfo('America/New_York')).timestamp()*1000)
assert len(shifted) == 1 and shifted[0]['start'] == expected_start and shifted[0]['end'] == expected_start+5400000, shifted
print('EDS RANGE wall-time shift and duration across DST passed')

master = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:range-day\r\nSUMMARY:Original all-day range\r\nDTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261202\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\n')
assert calendar_client.create_object_sync(master, ECal.OperationFlags.NONE, None)[0]
change = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:range-day\r\nSUMMARY:Shifted all-day range\r\nRECURRENCE-ID;VALUE=DATE;RANGE=THISANDFUTURE:20261201\r\nDTSTART;VALUE=DATE:20261202\r\nDTEND;VALUE=DATE:20261204\r\nEND:VEVENT\r\n')
assert calendar_client.modify_object_sync(change, ECal.ObjModType.THIS, ECal.OperationFlags.NONE, None)
day_start = int(datetime.datetime(2026,12,3).timestamp()*1000)
rows = call('calendarEvents', {'start':day_start, 'end':day_start+86400000})
shifted = sorted((r for r in rows if r['title'] == 'Shifted all-day range'), key=lambda r:r['start'])
assert len(shifted) == 2 and all(r['isAllDay'] for r in shifted), shifted
assert [(r['start'],r['end']) for r in shifted] == [(day_start-86400000,day_start),(day_start,day_start+86400000)], shifted
print('EDS RANGE all-day shift and inclusive output end passed')

# Multiple range anchors must apply only to their own recurrence interval.
for direction, expected in [
    ('THISANDFUTURE', [(1, 10), (2, 10), (3, 12), (4, 12), (5, 12)]),
    ('THISANDPRIOR', [(1, 10), (2, 10), (3, 12), (4, 12), (5, 9)]),
]:
    uid = 'multiple-' + direction.lower()
    master = ICalGLib.Component.new_from_string(f'BEGIN:VEVENT\r\nUID:{uid}\r\nSUMMARY:{uid}\r\nDTSTART:20270201T090000Z\r\nDTEND:20270201T100000Z\r\nRRULE:FREQ=DAILY;COUNT=5\r\nEND:VEVENT\r\n')
    assert calendar_client.create_object_sync(master, ECal.OperationFlags.NONE, None)[0]
    anchors = [(1,10), (3,12)] if direction == 'THISANDFUTURE' else [(2,10), (4,12)]
    for day, hour in anchors:
        change = ICalGLib.Component.new_from_string(f'BEGIN:VEVENT\r\nUID:{uid}\r\nSUMMARY:{uid}\r\nRECURRENCE-ID;RANGE={direction}:202702{day:02d}T090000Z\r\nDTSTART:202702{day:02d}T{hour:02d}0000Z\r\nDTEND:202702{day:02d}T{hour+1:02d}0000Z\r\nEND:VEVENT\r\n')
        assert calendar_client.modify_object_sync(change, ECal.ObjModType.THIS, ECal.OperationFlags.NONE, None)
    query = int(datetime.datetime(2027,2,1,tzinfo=datetime.timezone.utc).timestamp()*1000)
    rows = call('calendarEvents', {'start':query, 'end':query+5*86400000})
    actual = sorted((r['start'],r['end']) for r in rows if r['title'] == uid)
    starts = [int(datetime.datetime(2027,2,day,hour,tzinfo=datetime.timezone.utc).timestamp()*1000) for day,hour in expected]
    assert actual == [(start,start+3600000) for start in starts], (direction, actual)
print('EDS multiple future/prior anchors and unchanged interval passed')

# Inject genuine failures at EDS's shared-library boundary. Successful fixtures
# above still exercise the actual provider; these prove failures cannot look empty.
for fault in ['timezone', 'uid']:
    result = subprocess.run([executable], input=json.dumps({'method':'calendarEvents', 'params':{'start':start_dst, 'end':start_dst+86400000}})+'\n',
        text=True, capture_output=True, timeout=20,
        env={**os.environ, 'LD_PRELOAD':sys.argv[2], 'VOICE_PRODUCTIVITY_FAULT':fault})
    assert result.returncode != 0 and result.stdout == '', (fault, result.stdout)
    assert result.stderr.strip() == 'productivity request failed', result.stderr
print('EDS UID/timezone failures return no partial or empty-success result')

# The calendar editor (ADR-DESK-060's Linux amendment): ids, one event, the scopes of a change,
# deletion and refusals, on dates relative to today, clear of the fixed fixtures above.
def refused(method, params):
    return call(method, params).get('refused')
ms = lambda value: int(value.timestamp()*1000)
# Local wall times (naive), so each week's start keeps 09:00 in the system zone EDS counts in.
day0 = (datetime.datetime.now() + datetime.timedelta(days=400)).replace(hour=9, minute=0, second=0, microsecond=0)
week = lambda k: ms(day0 + datetime.timedelta(weeks=k))
# Days and minutes added in local wall time: a daylight-saving change between keeps the clock time.
at = lambda k, days=0, minutes=0: ms(day0 + datetime.timedelta(weeks=k, days=days, minutes=minutes))
span = {'start': week(-1), 'end': week(40)}
def rule(**fields):
    return {'frequency':'WEEKLY', 'interval':1, 'count':None, 'until':None, 'days':[], 'monthDays':[], 'months':[], 'positions':[], 'yearWeeks':[], 'yearDays':[], **fields}
def event(**fields):
    return {'title':'Weekly sync', 'start':week(0), 'end':week(0)+3600000, 'isAllDay':False, 'location':None, 'notes':None,
            'calendarId':None, 'availability':'busy', 'recurrence':None, 'attendees':[], **fields}
unchanged = {'invite':[], 'uninvite':[], 'exclude':[]}
def rows(title=None):
    return sorted((row for row in call('calendarEvents', span) if title is None or row['title'] == title), key=lambda row: row['start'])

calendars = call('calendars', {})
default = [calendar for calendar in calendars if calendar['isDefault']]
assert len(default) == 1 and default[0]['title'] and default[0]['account'], calendars
second = EDataServer.Source.new(None, None)
second.set_display_name('Second calendar')
second.set_parent('local-stub')
second.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR).set_backend_name('local')
assert registry.commit_source_sync(second, None)
assert {'id':second.get_uid(), 'title':'Second calendar', 'account':default[0]['account'], 'isDefault':False} in call('calendars', {})
chosen = call('calendarAdd', event(title='Chosen calendar', calendarId=second.get_uid(), start=week(1), end=week(1)+60000))
assert chosen['calendarId'] == second.get_uid() and chosen['calendar'] == 'Second calendar' and chosen['id'].startswith(second.get_uid() + '|')
assert refused('calendarAdd', event(calendarId='missing-calendar')) == 'noSuchCalendar'
assert call('calendarDelete', {'id':chosen['id']}) == {}
print('EDS writable calendar list, a chosen calendar and an unknown one passed')

zone = ECal.util_get_system_timezone_location()
series = call('calendarAdd', event(availability='free', recurrence=rule(count=30)))
assert series['occurrence'] == week(0) and series['availability'] == 'free' and series['calendarId'] == default[0]['id']
assert series['recurrence'] == rule(count=30) and not series['isDetached'] and not series['isInvitation'], series
assert series['timeZone'] == ('UTC' if zone in ('UTC', 'Etc/UTC') else zone), series
stored = calendar_client.get_object_sync(series['id'].split('|')[1], None, None)[1]
assert stored.get_first_property(ICalGLib.PropertyKind.TRANSP_PROPERTY).get_transp() == ICalGLib.PropertyTransp.TRANSPARENT
occurrences = rows('Weekly sync')
assert [row['start'] for row in occurrences] == [week(k) for k in range(30)], occurrences
# Thirty weeks cross a daylight-saving change wherever the system zone has one.
assert all(datetime.datetime.fromtimestamp(row['start']/1000).time() == day0.time() for row in occurrences)
assert all(row['id'] == series['id'] and row['occurrence'] == row['start'] for row in occurrences)
print('EDS repeating event created in the local zone, free, read back with its id and rule passed')

assert call('calendarEvent', {'id':series['id'], 'occurrence':None})['start'] == week(0)
assert call('calendarEvent', {'id':series['id'], 'occurrence':week(2)+3600000})['start'] == week(2)
assert refused('calendarEvent', {'id':series['id'], 'occurrence':week(2)+3*3600000}) == 'noSuchEvent'
for bad in ['no-separator', '|', 'missing-calendar|uid', series['id'] + '%41', series['id'] + 'x']:
    assert refused('calendarEvent', {'id':bad, 'occurrence':None}) == 'noSuchEvent', bad
call('calendarEvent', {'id':series['id'], 'occurrence':'tomorrow'}, False)
print('EDS event by id and occurrence, within the tolerance only, and unknown ids passed')

third = call('calendarEdit', {'id':series['id'], 'occurrence':week(2), 'scope':'thisOnly', 'title':'Third moved',
    'start':week(2)+3600000, 'end':week(2)+7200000, **unchanged})
assert third['isDetached'] and third['id'] != series['id'] and third['id'].startswith(series['id'] + '|'), third
assert third['occurrence'] == week(2) and third['start'] == week(2)+3600000 and third['recurrence'] == rule(count=30)
assert [row['start'] for row in rows('Weekly sync')] == [week(k) for k in range(30) if k != 2]
assert call('calendarEvent', {'id':series['id'], 'occurrence':week(2)})['id'] == third['id']
assert call('calendarEdit', {'id':third['id'], 'occurrence':None, 'scope':'thisOnly', 'location':'Room 4', **unchanged})['location'] == 'Room 4'
assert call('calendarEdit', {'id':third['id'], 'occurrence':None, 'scope':'thisOnly', 'location':'', **unchanged})['location'] is None
call('calendarEdit', {'id':third['id'], 'occurrence':None, 'scope':'thisOnly', 'recurrence':None, **unchanged}, False)
print('EDS one occurrence changed alone, then by its own id, passed')

assert refused('calendarEdit', {'id':series['id'], 'occurrence':None, 'scope':'all', **{**unchanged, 'exclude':[week(4), week(4)+5*3600000]}}) == 'noSuchEvent'
assert len(rows('Weekly sync')) == 29
call('calendarEdit', {'id':series['id'], 'occurrence':None, 'scope':'all', **{**unchanged, 'exclude':[week(4), week(5)]}})
assert [row['start'] for row in rows('Weekly sync')] == [week(k) for k in range(30) if k not in (2, 4, 5)]
print('EDS occurrences deleted from a series, all found before any is deleted, passed')

moved = call('calendarEdit', {'id':series['id'], 'occurrence':week(6), 'scope':'all',
    'start':at(6, 1, 30), 'end':at(6, 1, 30)+5400000, 'availability':'busy', **unchanged})
assert moved['id'] == series['id'] and moved['start'] == at(0, 1, 30) and moved['availability'] == 'busy', moved
later = rows('Weekly sync')
# Moved by a day to 09:30 local: deleted ones come back, the occurrence changed alone stays.
assert [row['start'] for row in later] == [at(k, 1, 30) for k in range(30)], later
assert all(row['end'] - row['start'] == 5400000 for row in later)
assert [row['start'] for row in rows('Third moved')] == [week(2)+3600000]
print('EDS series moved by days to a new time of day, keeping the length confirmed, passed')

following = call('calendarEdit', {'id':series['id'], 'occurrence':at(20, 1, 30), 'scope':'thisAndFollowing', 'title':'Later sync',
    'start':at(20, 1, 120), 'end':at(20, 1, 180), **unchanged})
assert following['id'] != series['id'] and following['id'].count('|') == 1 and following['occurrence'] == following['start'], following
assert following['recurrence'] == rule(count=10), following
assert [row['start'] for row in rows('Later sync')] == [at(k, 1, 120) for k in range(20, 30)]
assert [row['start'] for row in rows('Weekly sync')] == [at(k, 1, 30) for k in range(20)]
assert call('calendarEvent', {'id':series['id'], 'occurrence':None})['recurrence'] == rule(count=20)
single = call('calendarEdit', {'id':following['id'], 'occurrence':None, 'scope':'all', 'recurrence':None, **unchanged})
assert single['recurrence'] is None and single['occurrence'] is None and len(rows('Later sync')) == 1
print('EDS this and following split into a series of its own, and a rule ended, passed')

daily = call('calendarEdit', {'id':following['id'], 'occurrence':None, 'scope':'all',
    'recurrence':rule(frequency='DAILY', until=at(20, 3, 120)), **unchanged})
assert daily['recurrence'] == rule(frequency='DAILY', until=at(20, 3, 120)), daily
assert len(rows('Later sync')) == 3
assert call('calendarDelete', {'id':following['id']}) == {} and rows('Later sync') == []
print('EDS a rule set on a single event, with a timed end, passed')

assert call('calendarDelete', {'id':third['id']}) == {} and rows('Third moved') == []
assert len(rows('Weekly sync')) == 20
assert call('calendarDelete', {'id':series['id']}) == {} and rows('Weekly sync') == []
assert refused('calendarDelete', {'id':series['id']}) == 'noSuchEvent'
print('EDS deletion of one changed occurrence, then of a series, passed')

first_day = day0.replace(hour=0)
days = call('calendarAdd', event(title='Day series', start=ms(first_day), end=ms(first_day), isAllDay=True,
    recurrence=rule(until=ms(first_day + datetime.timedelta(weeks=3, days=1))-1)))
assert days['timeZone'] is None and days['recurrence']['until'] == ms(first_day + datetime.timedelta(weeks=3, days=1))-1, days
assert [row['start'] for row in rows('Day series')] == [ms(first_day + datetime.timedelta(weeks=k)) for k in range(4)]
call('calendarEdit', {'id':days['id'], 'occurrence':ms(first_day + datetime.timedelta(weeks=1)), 'scope':'all',
    'start':ms(first_day + datetime.timedelta(weeks=1, days=2)), 'end':ms(first_day + datetime.timedelta(weeks=1, days=3)), **unchanged})
moved_days = rows('Day series')
assert [(row['start'], row['end']) for row in moved_days[:2]] == [(ms(first_day + datetime.timedelta(weeks=k, days=2)), ms(first_day + datetime.timedelta(weeks=k, days=3))) for k in range(2)], moved_days
assert call('calendarDelete', {'id':days['id']}) == {}
timed = call('calendarAdd', event(title='Becomes all day', start=week(3), end=week(3)+3600000))
assert timed['occurrence'] is None and timed['recurrence'] is None and timed['timeZone'] == 'UTC'
whole = call('calendarEdit', {'id':timed['id'], 'occurrence':week(3), 'scope':'all', 'isAllDay':True,
    'start':ms(first_day + datetime.timedelta(weeks=3)), 'end':ms(first_day + datetime.timedelta(weeks=3)), **unchanged})
assert whole['isAllDay'] and whole['start'] == whole['end'] == ms(first_day + datetime.timedelta(weeks=3)), whole
assert call('calendarDelete', {'id':timed['id']}) == {}
print('EDS all-day series with a last day, moved by days, and a timed event made all day passed')

# A calendar on this computer has no server to send invitations.
assert refused('calendarAdd', event(attendees=[{'email':'invitee@example.com', 'name':'Invitee'}])) == 'calendarNoInvitations'
plain = call('calendarAdd', event(title='Plain event'))
assert refused('calendarEdit', {'id':plain['id'], 'occurrence':None, 'scope':'all', **{**unchanged, 'invite':[{'email':'invitee@example.com', 'name':None}]}}) == 'calendarNoInvitations'
for person in [{'email':'two\r\nATTENDEE:mailto:x@example.com', 'name':None}, {'email':'no-at-sign', 'name':None}, {'email':'a@example.com', 'name':'Quote " name'}]:
    call('calendarEdit', {'id':plain['id'], 'occurrence':None, 'scope':'all', **{**unchanged, 'invite':[person]}}, False)
call('calendarEdit', {'id':plain['id'], 'occurrence':None, 'scope':'all', 'start':week(0), **unchanged}, False)
call('calendarAdd', event(recurrence=rule(count=2, until=week(4))), False)
assert call('calendarEdit', {'id':plain['id'], 'occurrence':None, 'scope':'all', 'notes':'Agenda', **unchanged})['notes'] == 'Agenda'
assert call('calendarDelete', {'id':plain['id']}) == {}
invitation = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:invited-event\r\nSUMMARY:Invited\r\nDTSTART:' +
    datetime.datetime.fromtimestamp(week(8)/1000, datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '\r\nDURATION:PT1H\r\n' +
    'ORGANIZER;CN=Organizer:mailto:organizer@example.com\r\nATTENDEE;PARTSTAT=ACCEPTED;CN=Organizer:mailto:organizer@example.com\r\n' +
    'ATTENDEE;PARTSTAT=TENTATIVE:mailto:someone@example.com\r\nATTENDEE:mailto:other@example.com\r\nEND:VEVENT\r\n')
assert calendar_client.create_object_sync(invitation, ECal.OperationFlags.NONE, None)[0]
[invited] = rows('Invited')
assert invited['isInvitation'] and invited['organizer'] == {'email':'organizer@example.com', 'name':'Organizer', 'status':'unknown'}, invited
assert [(person['email'], person['status']) for person in invited['attendees']] == [('organizer@example.com', 'accepted'), ('someone@example.com', 'tentative'), ('other@example.com', 'pending')]
assert invited['end'] - invited['start'] == 3600000
assert refused('calendarEdit', {'id':invited['id'], 'occurrence':None, 'scope':'all', 'title':'Mine now', **unchanged}) == 'notOrganizer'
assert call('calendarDelete', {'id':invited['id']}) == {} and rows('Invited') == []
print('EDS invitations refused without a server, attendee checks, and an invitation read and kept as it is passed')
