# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Requires GTK3/VTE and a private GNOME session with the Voice caret extension.
# Do not run against a personal desktop: the fixture intentionally changes focus.
import os,sys,subprocess,tempfile,time,json,select
BASE_LINES=['first line','> hello world','visible-terminal-sentinel','status bar']
CHANGED_LINES=['first line','界😀 e\u0301 > hello world','changed-right-sentinel']
if '--fixture' in sys.argv:
 import gi
 gi.require_version('Gtk','3.0');gi.require_version('Vte','2.91')
 from gi.repository import Gtk,Vte,GLib
 window=Gtk.Window(title='Synthetic screen fixture');window.set_default_size(1000,420)
 box=Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,spacing=8);window.add(box)
 terminal=Vte.Terminal();right=Vte.Terminal()
 for pane in (terminal,right):
  pane.set_scrollback_lines(2000);box.pack_start(pane,True,True,0)
 window.show_all();terminal.grab_focus()
 def feed():
  shown='\r\n'.join(BASE_LINES)+'\x1b[2;8H'
  terminal.feed(('hidden-history-sentinel\r\n'+'old-line\r\n'*500+'\x1b[2J\x1b[H'+shown).encode());right.feed(shown.encode())
  print(json.dumps({'rows':terminal.get_row_count(),'rightRows':right.get_row_count()}),flush=True)
  return False
 GLib.timeout_add(500,feed)
 def command(stream, condition):
  action=stream.readline().strip()
  if action=='select':right.select_all()
  elif action=='right':right.grab_focus()
  elif action=='left':terminal.grab_focus()
  elif action=='change':right.feed(('\x1b[2J\x1b[H'+'\r\n'.join(CHANGED_LINES)+'\x1b[2;15H').encode())
  elif action=='hide':terminal.hide();right.grab_focus()
  return True
 GLib.io_add_watch(sys.stdin,GLib.IO_IN,command)
 Gtk.main();sys.exit()
import argparse
parser=argparse.ArgumentParser(description='Run only inside an isolated synthetic GNOME/AT-SPI session.')
parser.add_argument('--helper',required=True)
parser.add_argument('--diagnostics',required=True)
args=parser.parse_args()
helper=args.helper
with tempfile.TemporaryFile(mode='w+t') as diagnostic:
 # The screen is read by voice-screen-reader, a program of its own beside the helper.
 native=subprocess.Popen([os.path.join(os.path.dirname(helper),'voice-screen-reader')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=diagnostic,text=True)
 # The field read for correction learning is voice-field-reader's, a program of its own too.
 voice=subprocess.Popen([os.path.join(os.path.dirname(helper),'voice-field-reader')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=diagnostic,text=True)
 fixture=subprocess.Popen([sys.executable,__file__,'--fixture'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=diagnostic,text=True)
 seq=0
 try:
  # One reply per line feed (Python's readline ends a line only there and at CR; a box's rows are
  # joined with U+2029).
  def ask(process,method,params):
   global seq
   seq+=1;process.stdin.write(json.dumps({'id':seq,'method':method,'params':params})+'\n');process.stdin.flush()
   deadline=time.monotonic()+5
   while time.monotonic()<deadline:
    if not select.select([process.stdout],[],[],max(0,deadline-time.monotonic()))[0]:break
    reply=json.loads(process.stdout.readline())
    if reply.get('id')==seq:return reply
   raise RuntimeError('helper request timeout')
  def request():return ask(native,'readScreen',{'excludedAppIDs':[],'excludedHosts':[]})
  def field():
   window=ask(voice,'frontmostApp',{})['result']['window']
   return ask(voice,'focusedFieldValue',{'excludedAppIDs':[],'excludedHosts':[],'window':window,'maxLength':20000})['result']['value']
  deadline=time.monotonic()+15;screen=None
  while time.monotonic()<deadline:
   time.sleep(.3);reply=request();screen=reply.get('result')
   if screen and 'visible-terminal-sentinel' in screen.get('renderedText',''):break
  def capture_until(predicate):
   deadline=time.monotonic()+8
   while time.monotonic()<deadline:
    time.sleep(.15);value=request().get('result')
    if value and predicate(value):return value
   raise AssertionError(value)
  def viewport(value):return value['terminalViewport']
  def target(value):
   v=viewport(value);c=v['caret'];assert c['status']=='exact',v
   surface=next(s for s in v['surfaces'] if s['id']==c['surface'])
   run=next(r for r in surface['runs'] if r['id']==c['run'])
   before=run['text'].encode('utf-16-le')[:c['offset']*2].decode('utf-16-le')
   assert c['renderedOffset']==run['renderedOffset']+c['offset'],value
   rendered=value['renderedText'].encode('utf-16-le')
   assert rendered[run['renderedOffset']*2:c['renderedOffset']*2].decode('utf-16-le')==before,value
   return surface,before
  def send(action):fixture.stdin.write(action+'\n');fixture.stdin.flush()
  def record(stage,value):
   assert viewport(value)['complete'],value
   assert 'hidden-history-sentinel' not in json.dumps(value),value
   for surface in viewport(value)['surfaces']:
    changed=stage not in ('duplicate-splits','right-focus') and (stage=='hidden-left' or surface['frame'][0]>left_x)
    expected=changed_text if changed else base_text
    assert len(surface['runs'])==1,value
    run=surface['runs'][0]
    assert run['text']==expected,value
    raw=value['renderedText'].encode('utf-16-le');start=run['renderedOffset']*2
    assert raw[start:start+len(expected.encode('utf-16-le'))].decode('utf-16-le')==expected,value
   print(json.dumps({'stage':stage,'screen':value}),flush=True)
  screen=capture_until(lambda s:len(viewport(s)['surfaces'])==2)
  assert select.select([fixture.stdout],[],[],5)[0],'fixture geometry timeout'
  geometry=json.loads(fixture.stdout.readline());rows=geometry['rows']
  assert isinstance(rows,int) and 4<rows<500 and geometry['rightRows']==rows,geometry
  def expected_text(lines):return '\n'.join(lines+['']*(rows-len(lines)))+'\n'
  base_text=expected_text(BASE_LINES);changed_text=expected_text(CHANGED_LINES)
  left_x=min(s['frame'][0] for s in viewport(screen)['surfaces'])
  record('duplicate-splits',screen)
  assert viewport(screen)['complete'],screen
  assert screen['renderedText'].count('visible-terminal-sentinel')==2,screen
  assert 'hidden-history-sentinel' not in json.dumps(screen),screen
  left,before=target(screen);assert before.endswith('> hello'),before
  assert left['frame'][0]==min(s['frame'][0] for s in viewport(screen)['surfaces']),screen
  # The caret window is the cursor's row (no borders here: the pane is the box), so a dictation is
  # spaced from what is before the cursor; the field is the box, its rows joined by U+2029.
  assert screen['textBeforeCaret']=='> hello' and screen['textAfterCaret']==' world',screen
  box=field();assert isinstance(box,str) and box.split('\u2029')[:len(BASE_LINES)]==BASE_LINES,box
  assert 'hidden-history-sentinel' not in box and '\n' not in box,box
  print(json.dumps({'stage':'terminal-field','rows':box.count('\u2029')+1}),flush=True)
  send('right')
  screen=capture_until(lambda s:viewport(s)['caret']['status']=='exact' and target(s)[0]['frame'][0]>left['frame'][0])
  right,before=target(screen);assert before.endswith('> hello'),before
  record('right-focus',screen)
  send('change')
  screen=capture_until(lambda s:'changed-right-sentinel' in s['renderedText'])
  right,before=target(screen);assert before.endswith('界😀 e\u0301 > hello'),before
  assert screen['renderedText'].count('visible-terminal-sentinel')==1,screen
  record('right-mutated-unicode',screen)
  send('select')
  screen=capture_until(lambda s:bool(s.get('selectedText')))
  record('explicit-selection',screen)
  assert 'changed-right-sentinel' in screen['selectedText'],screen
  assert 'visible-terminal-sentinel' not in screen['selectedText'],screen
  assert not screen['selectionRedacted'],screen
  assert viewport(screen)['selectionComplete'],screen
  assert screen['selectedText']==changed_text[:-1],screen
  assert viewport(screen)['selectedText']==screen['selectedText'],screen
  selected,before=target(screen)
  ranges=selected['selection']['ranges'];assert len(ranges)==1,screen
  span=ranges[0];run=selected['runs'][0]
  assert span['run']==run['id'] and span['start']==0 and span['end']==len(changed_text[:-1].encode('utf-16-le'))//2,screen
  assert span['renderedStart']==run['renderedOffset'] and span['renderedEnd']==run['renderedOffset']+span['end'],screen
  assert selected['frame'][0]==right['frame'][0],screen
  assert before.endswith('界😀 e\u0301 > hello'),before
  send('left')
  screen=capture_until(lambda s:viewport(s)['caret']['status']=='exact' and target(s)[0]['frame'][0]==left['frame'][0])
  assert target(screen)[1].endswith('> hello'),screen
  assert screen['selectedText']==viewport(screen)['selectedText']=='',screen
  assert viewport(screen)['selectionComplete'] and not screen['selectionRedacted'],screen
  record('focus-returned-left',screen)
  send('hide')
  screen=capture_until(lambda s:len(viewport(s)['surfaces'])==1)
  record('hidden-left',screen)
  assert 'visible-terminal-sentinel' not in screen['renderedText'],screen
  assert 'changed-right-sentinel' in screen['renderedText'],screen
  assert target(screen)[1].endswith('界😀 e\u0301 > hello'),screen
  assert screen['selectedText']==viewport(screen)['selectedText']==changed_text[:-1],screen
  print(json.dumps({'passed':True,'test':'installed VTE splits selection and focus','duplicateSplits':True,'focusIdentity':True,'unicodeCaret':True,'selection':True,'hiddenSurfaceExcluded':True,'terminalField':True}),flush=True)
 finally:
  fixture.terminate();native.terminate();voice.terminate()
  for child in (fixture,native,voice):
   try:child.wait(timeout=3)
   except subprocess.TimeoutExpired:child.kill();child.wait()
  diagnostic.seek(0)
  open(args.diagnostics,'w').write(diagnostic.read())
