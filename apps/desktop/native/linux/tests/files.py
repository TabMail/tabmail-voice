# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Exercise the real prepared query against an in-memory index on a private bus.
import gi,json,subprocess,threading,sys
gi.require_version('Tsparql','3.0')
from gi.repository import Tsparql,Gio,GLib
conn=Tsparql.SparqlConnection.new(Tsparql.SparqlConnectionFlags.NONE,None,Tsparql.sparql_get_ontology_nepomuk(),None)
conn.update('''INSERT DATA {
 GRAPH tracker:FileSystem {
  <urn:tabmail-test:file> a nfo:FileDataObject ; nie:url 'file:///tmp/tabmail-synthetic-home/report.pdf'; nfo:fileName 'report.pdf'; nfo:fileLastModified '2026-02-01T00:00:00Z'^^xsd:dateTime .
  <urn:tabmail-test:other> a nfo:FileDataObject ; nie:url 'file:///outside/report.pdf'; nfo:fileName 'report.pdf'; nfo:fileLastModified '2026-03-01T00:00:00Z'^^xsd:dateTime .
  <urn:tabmail-test:folder> a nfo:Folder, nfo:FileDataObject ; nie:url 'file:///tmp/tabmail-synthetic-home/folder'; nfo:fileName 'folder'; nfo:fileLastModified '2026-04-01T00:00:00Z'^^xsd:dateTime .
 }
 GRAPH tracker:Documents { <urn:tabmail-test:content> a nfo:PaginatedTextDocument; nie:isStoredAs <urn:tabmail-test:file>; nie:mimeType 'application/pdf'; nie:title 'Quasar'; nie:plainTextContent 'Orchid alpha' . }
}''',None)
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',('org.freedesktop.LocalSearch3',0)),None,Gio.DBusCallFlags.NONE,1000,None)
endpoint=Tsparql.EndpointDBus.new(conn,bus,None,None)
loop=GLib.MainLoop(); results=[]
def run():
 try:
  for override,want in [({'words':['report']},1),({'words':['quasar'],'kind':'pdf'},1),({'words':['orchid']},1),({'words':['folder'],'kind':'folder'},1),({'words':['report'],'after':'2026-02-02T00:00:00Z'},0),({'words':["report') || true || ('"]},0)]:
   request={'words':['report'],'scope':'file:///tmp/tabmail-synthetic-home/','limit':10,'kind':'any','after':None,'before':None,**override}
   proc=subprocess.run([sys.argv[1]],input=json.dumps(request)+'\n',text=True,capture_output=True,timeout=5)
   rows=json.loads(proc.stdout) if proc.returncode==0 else None
   results.append({'input':request,'code':proc.returncode,'rows':rows,'stderr':proc.stderr,'passed':rows is not None and len(rows)==want and all(row[0].startswith('file:///tmp/tabmail-synthetic-home/') and row[1] in ('report.pdf', 'folder') for row in rows)})
 except Exception as e: results.append({'error':str(e)})
 finally: GLib.idle_add(loop.quit)
threading.Thread(target=run).start();loop.run()
print(json.dumps(results,indent=2));sys.exit(0 if all(x.get('passed') for x in results) and len(results)==6 else 1)
