// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { expect, test, vi } from "vitest";
import { LinuxPermissions } from "../../../../src/main/native/linux/permissions.js";
import type { HelperClient } from "../../../../src/main/native/helperClient.js";
function setup() {
 let insertion: (message: Record<string, unknown>) => void = () => {};
 let shortcut: (message: Record<string, unknown>) => void = () => {};
 let resolveInsert: (value: unknown) => void = () => {};
 let resolveShortcut: (value: unknown) => void = () => {};
 const requestInsert=vi.fn(() => new Promise(resolve => {resolveInsert=resolve;}));
 const requestShortcut=vi.fn(() => new Promise(resolve => {resolveShortcut=resolve;}));
 const permissions=new LinuxPermissions({on: (_:string,h:typeof insertion)=>{insertion=h;},request:requestInsert} as unknown as HelperClient,{on:(_:string,h:typeof shortcut)=>{shortcut=h;},request:requestShortcut} as unknown as HelperClient);
 return {permissions,requestInsert,requestShortcut,insertion:(granted:boolean)=>insertion({granted}),shortcut:(installed:boolean)=>shortcut({installed}),resolveInsert:(x:unknown)=>resolveInsert(x),resolveShortcut:(x:unknown)=>resolveShortcut(x)};
}
test("newer shortcut revocation beats a preceding successful authorization response",async()=>{
 const f=setup();f.insertion(false);
 f.permissions.askForAccessibility();expect(f.requestShortcut).toHaveBeenCalledTimes(1);
 // Native finish writes its grant event and reply, then a Closed signal writes revocation.
 // HelperClient resolves replies while synchronously delivering all lines in an output chunk.
 f.shortcut(true);f.resolveShortcut({installed:true});f.shortcut(false);
 expect(f.permissions.readAccessibility()).toBe(false);
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(f.permissions.readAccessibility()).toBe(false);
 expect(f.requestInsert).not.toHaveBeenCalled();
});
test("newer insertion revocation beats a preceding successful restoration response",async()=>{
 const f=setup();f.shortcut(true);f.permissions.restore();
 f.insertion(true);f.resolveInsert({granted:true});f.insertion(false);
 expect(f.permissions.readAccessibility()).toBe(false);
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(f.permissions.readAccessibility()).toBe(false);
});
test("a current native grant allows normal readiness",async()=>{
 const f=setup();f.insertion(true);f.permissions.askForAccessibility();
 f.shortcut(true);f.resolveShortcut({installed:true});
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(f.permissions.readAccessibility()).toBe(true);
});
test("actual HelperClient preserves revocation in a single stdout batch",async()=>{
 const {HelperClient}=await import("../../../../src/main/native/helperClient.js");
 const code=`const rl=require('node:readline').createInterface({input:process.stdin}); rl.on('line',line=>{const r=JSON.parse(line);process.stdout.write([{event:'hotkeyInstallationChanged',installed:true},{id:r.id,result:{installed:true}},{event:'hotkeyInstallationChanged',installed:false}].map(x=>JSON.stringify(x)).join('\\n')+'\\n');});`;
 const hotkey=new HelperClient({name:"synthetic-hotkey",executable:process.execPath,args:["-e",code]});
 let nativeEvent:(message:Record<string,unknown>)=>void=()=>{};
 const insertion={on:(_:string,h:typeof nativeEvent)=>{nativeEvent=h;},request:vi.fn()};
 const permissions=new LinuxPermissions(insertion as unknown as HelperClient,hotkey);
 const changes: boolean[] = [];
 permissions.onChange = () => changes.push(permissions.readAccessibility());
 hotkey.start();nativeEvent({granted:true});
 try {
  permissions.askForAccessibility();
  await vi.waitFor(() => expect(changes).toEqual([false, true, false]));
  expect(permissions.readAccessibility()).toBe(false);
 } finally {hotkey.stop();}
});
test('the real PermissionsModel shortcut refresh cannot repair stale insertion restoration',async()=>{
 const {PermissionsModel}=await import('../../../../src/core/onboarding/permissions.js');
 const f=setup();f.shortcut(true);f.requestShortcut.mockResolvedValue({installed:true});
 const model=new PermissionsModel(f.permissions);
 f.permissions.onChange=()=>model.refresh();
 model.onAccessibilityGranted=()=>{void f.requestShortcut();};
 f.permissions.restore();
 f.insertion(true);f.resolveInsert({granted:true});f.insertion(false);
 await new Promise(resolve=>setTimeout(resolve,0));
 const trustedBeforeRetry=model.accessibilityTrusted;
 model.requestAccessibility();
 const insertionRequests=f.requestInsert.mock.calls.length;
 model.stopPolling();
 expect({trustedBeforeRetry,insertionRequests}).toEqual({trustedBeforeRetry:false,insertionRequests:2});
});
