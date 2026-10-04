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
