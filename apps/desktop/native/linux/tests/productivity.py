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

# A read that a change interrupts is made again: a change notice on its first view (EDS can send one
# for a change saved just before) gives the rows a quiet read gives, and a source that keeps
# changing fails with nothing, never a mix of versions.
def faulted(method, params, fault):
    return subprocess.run([executable], input=json.dumps({'method':method, 'params':params})+'\n',
        text=True, capture_output=True, timeout=20, env={**os.environ, 'LD_PRELOAD':sys.argv[2], 'VOICE_PRODUCTIVITY_FAULT':fault})
for method, params in [('calendarEvents', {'start':start_dst, 'end':start_dst+86400000}), ('reminders', {'dueBefore':None}), ('notesSearch', {'query':'Synthetic memo'})]:
    quiet = call(method, params)
    assert quiet, method
    for fault in ['changed-first', 'removed-first']:
        again = faulted(method, params, fault)
        assert again.returncode == 0 and json.loads(again.stdout) == quiet, (method, fault, again.stderr)
    for fault in ['changed', 'removed']:
        changing = faulted(method, params, fault)
        assert changing.returncode != 0 and changing.stdout == '' and changing.stderr.strip() == 'productivity request failed', (method, fault, changing.stdout)
print('EDS reads interrupted by a change are made again, and a source that keeps changing fails with nothing')

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
assert series['occurrence'] == week(0) and series['availability'] == 'free' and series['calendarId'] == default[0]['id'], (series, week(0), zone)
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
    'ATTENDEE;PARTSTAT=TENTATIVE:mailto:someone@example.com\r\nATTENDEE:mailto:other@example.com\r\nATTENDEE;PARTSTAT=DECLINED:mailto:declined@example.com\r\nEND:VEVENT\r\n')
assert calendar_client.create_object_sync(invitation, ECal.OperationFlags.NONE, None)[0]
[invited] = rows('Invited')
assert invited['isInvitation'] and invited['organizer'] == {'email':'organizer@example.com', 'name':'Organizer', 'status':'unknown'}, invited
assert [(person['email'], person['status']) for person in invited['attendees']] == [('organizer@example.com', 'accepted'), ('someone@example.com', 'tentative'), ('other@example.com', 'pending'), ('declined@example.com', 'declined')]
assert invited['end'] - invited['start'] == 3600000
assert refused('calendarEdit', {'id':invited['id'], 'occurrence':None, 'scope':'all', 'title':'Mine now', **unchanged}) == 'notOrganizer'
assert call('calendarDelete', {'id':invited['id']}) == {} and rows('Invited') == []
print('EDS invitations refused without a server, attendee checks, and an invitation read and kept as it is passed')
attended = ICalGLib.Component.new_from_string('BEGIN:VEVENT\r\nUID:attended-event\r\nSUMMARY:Attended\r\nDTSTART:' +
    datetime.datetime.fromtimestamp(week(9)/1000, datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '\r\nDURATION:PT1H\r\n' +
    'ATTENDEE:mailto:guest@example.com\r\nEND:VEVENT\r\n')
assert calendar_client.create_object_sync(attended, ECal.OperationFlags.NONE, None)[0]
[guests] = rows('Attended')
assert not guests['isInvitation'] and [person['email'] for person in guests['attendees']] == ['guest@example.com'], guests
# Removing someone tells them, as adding does: refused where nothing is sent, and they stay.
assert refused('calendarEdit', {'id':guests['id'], 'occurrence':None, 'scope':'all', **{**unchanged, 'uninvite':['guest@example.com']}}) == 'calendarNoInvitations'
assert [person['email'] for person in rows('Attended')[0]['attendees']] == ['guest@example.com']
assert call('calendarDelete', {'id':guests['id']}) == {}
print('EDS removing someone refused without a server, and they stay invited, passed')

# Rules the app can't be told read as one event at each occurrence: the series is changed and deleted
# in the calendar app, one occurrence changed on its own here.
utc = lambda value: datetime.datetime.fromtimestamp(value/1000, datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
for uid, repeat in [('hourly-series', 'RRULE:FREQ=HOURLY;COUNT=3'), ('by-hour-series', 'RRULE:FREQ=DAILY;COUNT=3;BYHOUR=9,10'),
                    ('dated-series', 'RDATE:' + utc(week(10)+86400000))]:
    seeded = ICalGLib.Component.new_from_string(f'BEGIN:VEVENT\r\nUID:{uid}\r\nSUMMARY:{uid}\r\nDTSTART:{utc(week(10))}\r\nDURATION:PT30M\r\n{repeat}\r\nEND:VEVENT\r\n')
    assert calendar_client.create_object_sync(seeded, ECal.OperationFlags.NONE, None)[0]
    before = rows(uid)
    assert len(before) > 1 and all(row['recurrence'] is None and row['occurrence'] is not None for row in before), before
    assert refused('calendarEdit', {'id':before[0]['id'], 'occurrence':None, 'scope':'all', 'title':'Renamed', **unchanged}) == 'unsupportedRecurrence'
    assert refused('calendarEdit', {'id':before[0]['id'], 'occurrence':before[1]['start'], 'scope':'all', 'title':'Renamed', **unchanged}) == 'unsupportedRecurrence'
    assert refused('calendarDelete', {'id':before[0]['id']}) == 'unsupportedRecurrence'
    assert rows(uid) == before and rows('Renamed') == []
    alone = ICalGLib.Component.new_from_string(f'BEGIN:VEVENT\r\nUID:{uid}\r\nSUMMARY:{uid} moved\r\nRECURRENCE-ID:{utc(before[1]["start"])}\r\nDTSTART:{utc(before[1]["start"]+3600000)}\r\nDURATION:PT30M\r\nEND:VEVENT\r\n')
    assert calendar_client.modify_object_sync(alone, ECal.ObjModType.THIS, ECal.OperationFlags.NONE, None)
    [detached] = rows(uid + ' moved')
    assert call('calendarEdit', {'id':detached['id'], 'occurrence':None, 'scope':'thisOnly', 'title':uid + ' alone', **unchanged})['title'] == uid + ' alone'
    assert call('calendarDelete', {'id':detached['id']}) == {} and rows(uid + ' alone') == [] and len(rows(uid)) == len(before) - 1
    assert calendar_client.remove_object_sync(uid, None, ECal.ObjModType.ALL, ECal.OperationFlags.NONE, None)
print('EDS series repeating by an hour, by hours or by dates refused as a whole, an occurrence changed alone kept editable, passed')

excluding = call('calendarAdd', event(title='Exclude and rename', start=week(10), end=week(10)+3600000, recurrence=rule(count=6)))
call('calendarEdit', {'id':excluding['id'], 'occurrence':None, 'scope':'all', 'title':'Renamed series', **{**unchanged, 'exclude':[week(11), week(12)]}})
assert [row['start'] for row in rows('Renamed series')] == [week(k) for k in range(10, 16) if k not in (11, 12)] and rows('Exclude and rename') == []
assert call('calendarDelete', {'id':excluding['id']}) == {}
print('EDS occurrences deleted together with another change stay deleted, passed')

whole = call('calendarAdd', event(title='Whole from first', start=week(16), end=week(16)+3600000, recurrence=rule(count=4)))
renamed = call('calendarEdit', {'id':whole['id'], 'occurrence':week(16), 'scope':'thisAndFollowing', 'title':'Whole renamed', **unchanged})
assert renamed['id'] == whole['id'] and renamed['recurrence'] == rule(count=4), renamed
assert [row['start'] for row in rows('Whole renamed')] == [week(k) for k in range(16, 20)] and rows('Whole from first') == []
assert call('calendarDelete', {'id':whole['id']}) == {}
print('EDS this and following from the first occurrence changes the series without splitting it, passed')

day_weeks = lambda k: ms(first_day + datetime.timedelta(weeks=k))
weekly_days = call('calendarAdd', event(title='Day weekly', start=day_weeks(17), end=day_weeks(17), isAllDay=True, recurrence=rule(count=3)))
alone_day = call('calendarEdit', {'id':weekly_days['id'], 'occurrence':day_weeks(18), 'scope':'thisOnly', 'title':'Day moved alone', **unchanged})
assert alone_day['isDetached'] and alone_day['isAllDay'] and alone_day['occurrence'] == day_weeks(18), alone_day
assert [row['start'] for row in rows('Day weekly')] == [day_weeks(17), day_weeks(19)]
assert [(row['start'], row['isAllDay']) for row in rows('Day moved alone')] == [(day_weeks(18), True)]
assert call('calendarDelete', {'id':weekly_days['id']}) == {} and rows('Day moved alone') == []
print('EDS one day of an all-day series changed alone, without a second copy, passed')

ruled = call('calendarAdd', event(title='Rule split', start=week(20), end=week(20)+3600000, recurrence=rule(count=6)))
later_rule = rule(frequency='DAILY', until=at(23, 2, 60))
split = call('calendarEdit', {'id':ruled['id'], 'occurrence':week(23), 'scope':'thisAndFollowing', 'recurrence':later_rule, **unchanged})
assert split['id'] != ruled['id'] and split['recurrence'] == later_rule, split
assert call('calendarEvent', {'id':ruled['id'], 'occurrence':None})['recurrence'] == rule(count=3)
assert [row['start'] for row in rows('Rule split')] == [week(20), week(21), week(22), week(23), at(23, 1), at(23, 2)]
assert call('calendarDelete', {'id':ruled['id']}) == {} and call('calendarDelete', {'id':split['id']}) == {}
print('EDS a new rule from one occurrence on leaves the ones before it as they were, passed')

# A single event saved in UTC, made to repeat weekly: its occurrences keep the time of day in the
# user's zone across a daylight-saving change, as one created repeating does.
made = call('calendarAdd', event(title='Made weekly'))
assert made['timeZone'] == 'UTC', made
weekly = call('calendarEdit', {'id':made['id'], 'occurrence':None, 'scope':'all', 'recurrence':rule(count=30), **unchanged})
assert weekly['timeZone'] == ('UTC' if zone in ('UTC', 'Etc/UTC') else zone), (weekly, zone)
assert [row['start'] for row in rows('Made weekly')] == [week(k) for k in range(30)]
assert call('calendarDelete', {'id':made['id']}) == {}
print('EDS a single event made to repeat keeps its local time of day, passed')

# A change from one occurrence on is made to the new series as confirmed: EDS counts a split's
# COUNT from the series it ends, and puts back a start that still falls on one of its occurrences.
counted = call('calendarAdd', event(title='Counted split', start=week(24), end=week(24)+3600000, recurrence=rule(count=6)))
# Another event already starting there is not the new series.
same_time = call('calendarAdd', event(title='Same time', start=week(27), end=week(27)+1800000))
counted_new = call('calendarEdit', {'id':counted['id'], 'occurrence':week(27), 'scope':'thisAndFollowing',
    'recurrence':rule(frequency='DAILY', count=5), **unchanged})
assert counted_new['id'] not in (None, counted['id']) and counted_new['recurrence'] == rule(frequency='DAILY', count=5), counted_new
assert [row['start'] for row in rows('Counted split')] == [week(24), week(25), week(26)] + [at(27, day) for day in range(5)]
assert [row['start'] for row in rows('Same time')] == [week(27)]
assert call('calendarDelete', {'id':counted['id']}) == {} and call('calendarDelete', {'id':counted_new['id']}) == {} and call('calendarDelete', {'id':same_time['id']}) == {}
daily_split = call('calendarAdd', event(title='Daily split', start=week(28), end=week(28)+3600000, recurrence=rule(frequency='DAILY', count=6)))
earlier = call('calendarEdit', {'id':daily_split['id'], 'occurrence':at(28, 3), 'scope':'thisAndFollowing', 'title':'Daily earlier',
    'start':at(28, 2), 'end':at(28, 2)+3600000, **unchanged})
assert earlier['id'] not in (None, daily_split['id']) and earlier['start'] == at(28, 2) and earlier['recurrence'] == rule(frequency='DAILY', count=3), earlier
assert [row['start'] for row in rows('Daily split')] == [at(28, day) for day in range(3)]
assert [row['start'] for row in rows('Daily earlier')] == [at(28, day) for day in range(2, 5)]
assert call('calendarDelete', {'id':daily_split['id']}) == {} and call('calendarDelete', {'id':earlier['id']}) == {}
print('EDS this and following saves a new counted rule and a start moved back by whole days as confirmed, passed')

# A series another app stored in UTC keeps its instants when only its rule changes.
utc_series = ICalGLib.Component.new_from_string(f'BEGIN:VEVENT\r\nUID:utc-series\r\nSUMMARY:UTC series\r\nDTSTART:{utc(week(0))}\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;COUNT=30\r\nEND:VEVENT\r\n')
assert calendar_client.create_object_sync(utc_series, ECal.OperationFlags.NONE, None)[0]
utc_starts = [row['start'] for row in rows('UTC series')]
assert len(utc_starts) == 30
utc_first = rows('UTC series')[0]
ended = call('calendarEdit', {'id':utc_first['id'], 'occurrence':None, 'scope':'all', 'recurrence':rule(count=20), **unchanged})
assert ended['timeZone'] == 'UTC' and ended['recurrence'] == rule(count=20), ended
assert [row['start'] for row in rows('UTC series')] == utc_starts[:20]
assert call('calendarDelete', {'id':utc_first['id']}) == {}
print('EDS a rule changed on a series stored in UTC leaves its instants as they were, passed')

# Every rule field the app writes reads back as written, and is stored as RFC 5545 says it.
weekday = lambda code, week=0: {'weekday':['SU','MO','TU','WE','TH','FR','SA'].index(code)+1, 'week':week}
for repeat, stored_rule in [
    (rule(interval=2, days=[weekday('TU'), weekday('FR')], count=4), 'FREQ=WEEKLY;COUNT=4;INTERVAL=2;BYDAY=TU,FR'),
    (rule(frequency='MONTHLY', days=[weekday('MO', -1)], count=3), 'FREQ=MONTHLY;COUNT=3;BYDAY=-1MO'),
    (rule(frequency='MONTHLY', monthDays=[1, -1], count=3), 'FREQ=MONTHLY;COUNT=3;BYMONTHDAY=1,-1'),
    (rule(frequency='YEARLY', months=[3], count=2), 'FREQ=YEARLY;COUNT=2;BYMONTH=3'),
    (rule(frequency='YEARLY', yearWeeks=[10], days=[weekday('MO')], count=2), 'FREQ=YEARLY;COUNT=2;BYDAY=MO;BYWEEKNO=10'),
    (rule(frequency='YEARLY', yearDays=[100], count=2), 'FREQ=YEARLY;COUNT=2;BYYEARDAY=100'),
    (rule(frequency='MONTHLY', days=[weekday(code) for code in ['MO','TU','WE','TH','FR']], positions=[-1], count=2), 'FREQ=MONTHLY;COUNT=2;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'),
]:
    saved_rule = call('calendarAdd', event(title='Rule fields', start=week(31), end=week(31)+3600000, recurrence=repeat))
    assert saved_rule['recurrence'] == repeat, (saved_rule['recurrence'], repeat)
    assert call('calendarEvent', {'id':saved_rule['id'], 'occurrence':None})['recurrence'] == repeat
    component = calendar_client.get_object_sync(saved_rule['id'].split('|')[1], None, None)[1]
    written = component.get_first_property(ICalGLib.PropertyKind.RRULE_PROPERTY).get_rrule().to_string()
    assert set(written.split(';')) - {'INTERVAL=1'} == set(stored_rule.split(';')), (written, stored_rule)
    assert call('calendarDelete', {'id':saved_rule['id']}) == {}
print('EDS every rule field written and read back: interval, weekdays, nth weekday, month days, months, weeks, year days, positions, passed')

# On a calendar whose server sends invitations (the provider's answers injected), the user is the
# organizer, each person is invited once, and the organizer is never removed.
def served(method, params):
    result = faulted(method, params, 'server')
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)
people = lambda row: [person['email'] for person in row['attendees']]
shared = served('calendarAdd', event(title='Shared event', start=week(32), end=week(32)+3600000, attendees=[{'email':'a@example.com', 'name':'A'}]))
assert people(shared) == ['a@example.com'] and shared['organizer']['email'] == 'me@example.com' and not shared['isInvitation'], shared
again = served('calendarEdit', {'id':shared['id'], 'occurrence':None, 'scope':'all',
    **{**unchanged, 'invite':[{'email':'A@example.com', 'name':None}, {'email':'b@example.com', 'name':None}, {'email':'me@example.com', 'name':None}]}})
assert people(again) == ['a@example.com', 'b@example.com', 'me@example.com'] and again['organizer']['email'] == 'me@example.com', again
fewer = served('calendarEdit', {'id':shared['id'], 'occurrence':None, 'scope':'all', **{**unchanged, 'uninvite':['A@example.com', 'me@example.com']}})
assert people(fewer) == ['b@example.com', 'me@example.com'] and fewer['organizer']['email'] == 'me@example.com', fewer
organized = served('calendarEdit', {'id':shared['id'], 'occurrence':None, 'scope':'all', 'title':'Still mine', **unchanged})
assert organized['title'] == 'Still mine' and people(organized) == ['b@example.com', 'me@example.com']
assert call('calendarDelete', {'id':shared['id']}) == {}
print('EDS invitations through a calendar that sends them: the user organizes, each person once, the organizer kept, passed')

# A calendar that can't be written, and no default calendar, refuse before anything is saved.
def answered(method, params, fault):
    result = faulted(method, params, fault)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)
writable = call('calendarAdd', event(title='Writable event', start=week(33), end=week(33)+3600000))
assert answered('calendars', {}, 'readonly') == []
assert answered('calendarAdd', event(title='Read only event'), 'readonly') == {'refused':'calendarReadOnly'}
assert answered('calendarEdit', {'id':writable['id'], 'occurrence':None, 'scope':'all', 'title':'Read only event', **unchanged}, 'readonly') == {'refused':'calendarReadOnly'}
assert answered('calendarDelete', {'id':writable['id']}, 'readonly') == {'refused':'calendarReadOnly'}
assert answered('calendarAdd', event(title='No default event'), 'nodefault') == {'refused':'noDefaultCalendar'}
# A server that sends invitations but doesn't know the user's address can't send them from the user.
assert answered('calendarEdit', {'id':writable['id'], 'occurrence':None, 'scope':'all', **{**unchanged, 'invite':[{'email':'a@example.com', 'name':None}]}}, 'schedules') == {'refused':'calendarNoInvitations'}
assert people(rows('Writable event')[0]) == []
assert rows('Read only event') == [] and rows('No default event') == [] and len(rows('Writable event')) == 1
assert call('calendarDelete', {'id':writable['id']}) == {}
print('EDS a read-only calendar and a missing default calendar refuse without saving, passed')

# A split names its occurrence in the series' own zone, as EDS's server backends (Google, CalDAV,
# Exchange) take it for the new series' start; its local backend converts it itself, so what the
# backend receives is read here (recorded at the library boundary).
record = os.path.join(os.environ['HOME'], 'split-recurrence-id.txt')
zoned = call('calendarAdd', event(title='Zoned split', start=week(34), end=week(34)+3600000, recurrence=rule(count=6)))
recorded = subprocess.run([executable], input=json.dumps({'method':'calendarEdit', 'params':{'id':zoned['id'], 'occurrence':week(36),
    'scope':'thisAndFollowing', 'title':'Zoned later', **unchanged}})+'\n', text=True, capture_output=True, timeout=20,
    env={**os.environ, 'LD_PRELOAD':sys.argv[2], 'VOICE_PRODUCTIVITY_FAULT':'record', 'VOICE_PRODUCTIVITY_RECORD':record})
assert recorded.returncode == 0, recorded.stderr
# One line per split, unfolded (RFC 5545 folds a long one).
[named] = open(record).read().replace('\r\n ', '').replace('\n ', '').splitlines()
assert named.rstrip('Z').endswith(':' + (day0 + datetime.timedelta(weeks=36)).strftime('%Y%m%dT%H%M%S')), named
if zone not in ('UTC', 'Etc/UTC'): assert ';TZID=' in named and zone in named, named
assert [row['start'] for row in rows('Zoned split')] == [week(34), week(35)] and [row['start'] for row in rows('Zoned later')] == [week(k) for k in range(36, 40)]
assert call('calendarDelete', {'id':zoned['id']}) == {} and call('calendarDelete', {'id':json.loads(recorded.stdout)['id']}) == {}
print("EDS a split names its occurrence in the series' zone, as a server backend keeps it, passed")

# Where the series' start is excluded, EDS counts the next occurrence as the first and changes the
# whole series from it: so does the helper.
first_gone = call('calendarAdd', event(title='First excluded', start=week(35), end=week(35)+3600000, recurrence=rule(frequency='DAILY', count=5)))
call('calendarEdit', {'id':first_gone['id'], 'occurrence':None, 'scope':'all', **{**unchanged, 'exclude':[week(35)]}})
renamed_first = call('calendarEdit', {'id':first_gone['id'], 'occurrence':at(35, 1), 'scope':'thisAndFollowing', 'title':'First excluded renamed', **unchanged})
assert renamed_first['id'] == first_gone['id'] and renamed_first['recurrence'] == rule(frequency='DAILY', count=5), renamed_first
assert [row['start'] for row in rows('First excluded renamed')] == [at(35, day) for day in range(1, 5)] and rows('First excluded') == []
# Moved from there, every occurrence moves by as much from the series' own start, which comes back as
# the confirmation says deleted ones do; the count is the series'.
call('calendarEdit', {'id':first_gone['id'], 'occurrence':at(35, 1), 'scope':'thisAndFollowing', 'start':at(35, 1, 60), 'end':at(35, 1, 120), **unchanged})
assert [row['start'] for row in rows('First excluded renamed')] == [at(35, day, 60) for day in range(5)]
assert call('calendarDelete', {'id':first_gone['id']}) == {}
print('EDS this and following from the first occurrence left after an excluded start changes the series, passed')

# A series another app changed from one occurrence on (RANGE), or whose rule the app reads only in
# part (RDATE, EXRULE), is changed in the calendar app, though it can be deleted here.
for uid, extra in [('ranged-series', None), ('extra-dates', 'RDATE:' + utc(week(36)+86400000)), ('dropped-dates', 'EXRULE:FREQ=WEEKLY;COUNT=1')]:
    seeded = ICalGLib.Component.new_from_string(f'BEGIN:VEVENT\r\nUID:{uid}\r\nSUMMARY:{uid}\r\nDTSTART:{utc(week(36))}\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=3\r\n' + (extra + '\r\n' if extra else '') + 'END:VEVENT\r\n')
    assert calendar_client.create_object_sync(seeded, ECal.OperationFlags.NONE, None)[0]
    if extra is None:
        ranged = ICalGLib.Component.new_from_string(f'BEGIN:VEVENT\r\nUID:{uid}\r\nSUMMARY:{uid} later\r\nRECURRENCE-ID;RANGE=THISANDFUTURE:{utc(week(36)+86400000)}\r\nDTSTART:{utc(week(36)+86400000+3600000)}\r\nDURATION:PT1H\r\nEND:VEVENT\r\n')
        assert calendar_client.modify_object_sync(ranged, ECal.ObjModType.THIS, ECal.OperationFlags.NONE, None)
    before = rows(uid) + rows(uid + ' later')
    assert before and all(row['recurrence'] is not None for row in before), before
    for row in before:
        for scope in ['all', 'thisOnly', 'thisAndFollowing']:
            assert refused('calendarEdit', {'id':row['id'], 'occurrence':row['occurrence'], 'scope':scope, 'title':'Changed here', **unchanged}) == 'unsupportedRecurrence', (uid, row, scope)
    assert rows(uid) + rows(uid + ' later') == before and rows('Changed here') == []
    assert call('calendarDelete', {'id':before[0]['id']}) == {} and rows(uid) == [] and rows(uid + ' later') == []
print("EDS series with another app's change from one occurrence on, added dates or a removal rule refused for changes, deleted, passed")

# A floating series (no zone, read in the user's) moved by its occurrences keeps the wall time.
floating_start = (day0 + datetime.timedelta(weeks=0)).strftime('%Y%m%dT%H%M%S')
floating_series = ICalGLib.Component.new_from_string(f'BEGIN:VEVENT\r\nUID:floating-series\r\nSUMMARY:Floating series\r\nDTSTART:{floating_start}\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;COUNT=30\r\nEND:VEVENT\r\n')
assert calendar_client.create_object_sync(floating_series, ECal.OperationFlags.NONE, None)[0]
floating_rows = rows('Floating series')
assert [row['start'] for row in floating_rows] == [week(k) for k in range(30)], floating_rows
call('calendarEdit', {'id':floating_rows[0]['id'], 'occurrence':week(3), 'scope':'all', 'start':at(3, 0, 30), 'end':at(3, 0, 90), **unchanged})
assert [row['start'] for row in rows('Floating series')] == [at(k, 0, 30) for k in range(30)]
assert call('calendarDelete', {'id':floating_rows[0]['id']}) == {}
# Changed from its first occurrence on, a floating series changes as a whole, as EDS decides it
# from the recurrence id it parses; from a later one it is split there, at the same local time.
floating_first = ICalGLib.Component.new_from_string(f'BEGIN:VEVENT\r\nUID:floating-first\r\nSUMMARY:Floating first\r\nDTSTART:{floating_start}\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEND:VEVENT\r\n')
assert calendar_client.create_object_sync(floating_first, ECal.OperationFlags.NONE, None)[0]
first_rows = rows('Floating first')
call('calendarEdit', {'id':first_rows[0]['id'], 'occurrence':week(0), 'scope':'thisAndFollowing', 'title':'Floating renamed', **unchanged})
assert [row['start'] for row in rows('Floating renamed')] == [week(k) for k in range(4)] and rows('Floating first') == []
assert {row['id'] for row in rows('Floating renamed')} == {first_rows[0]['id']}
renamed = rows('Floating renamed')
call('calendarEdit', {'id':renamed[0]['id'], 'occurrence':week(2), 'scope':'thisAndFollowing', 'title':'Floating later', **unchanged})
assert [row['start'] for row in rows('Floating renamed')] == [week(0), week(1)]
assert [row['start'] for row in rows('Floating later')] == [week(2), week(3)]
for title in ['Floating renamed', 'Floating later']:
    assert call('calendarDelete', {'id':rows(title)[0]['id']}) == {}
print('EDS a floating series moved keeps its local time of day, changed from its first occurrence as a whole, passed')

# An occurrence another app changed alone, under its own zoned recurrence id, is deleted as itself.
new_york = ZoneInfo('America/New_York')
york = lambda k: datetime.datetime.fromtimestamp(week(37)/1000, new_york).replace(tzinfo=None) + datetime.timedelta(weeks=k)
york_ms = lambda k: int(york(k).replace(tzinfo=new_york).timestamp()*1000)
york_series = ICalGLib.Component.new_from_string(f"BEGIN:VEVENT\r\nUID:york-series\r\nSUMMARY:York series\r\nDTSTART;TZID=America/New_York:{york(0).strftime('%Y%m%dT%H%M%S')}\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\n")
assert calendar_client.create_object_sync(york_series, ECal.OperationFlags.NONE, None)[0]
york_alone = ICalGLib.Component.new_from_string(f"BEGIN:VEVENT\r\nUID:york-series\r\nSUMMARY:York alone\r\nRECURRENCE-ID;TZID=America/New_York:{york(1).strftime('%Y%m%dT%H%M%S')}\r\nDTSTART;TZID=America/New_York:{(york(1) + datetime.timedelta(hours=2)).strftime('%Y%m%dT%H%M%S')}\r\nDURATION:PT1H\r\nEND:VEVENT\r\n")
assert calendar_client.modify_object_sync(york_alone, ECal.ObjModType.THIS, ECal.OperationFlags.NONE, None)
york_rows = rows('York series')
assert [row['start'] for row in york_rows] == [york_ms(0), york_ms(2)] and len(rows('York alone')) == 1, york_rows
call('calendarEdit', {'id':york_rows[0]['id'], 'occurrence':None, 'scope':'all', **{**unchanged, 'exclude':[york_ms(1)]}})
assert rows('York alone') == [] and [row['start'] for row in rows('York series')] == [york_ms(0), york_ms(2)]
assert call('calendarDelete', {'id':york_rows[0]['id']}) == {}
print('EDS an occurrence changed alone by another app, deleted by its date from the series, passed')
