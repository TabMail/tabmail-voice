import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ExecFileOptionsWithStringEncoding, ExecFileException } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { productivityRunner } from '../../../src/main/native/productivity.js';
// Only supply the interpreter needed by the synthetic fixture on all three OSes.
// The actual child, stdin, callback, signal, deadline and output limits stay real.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: (executable: string, args: string[], options: ExecFileOptionsWithStringEncoding,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) =>
    actual.execFile(process.execPath, [executable, ...args], options, callback) };
});
let root: string, executable: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tabmail-synthetic-runner-'));
  executable = join(root, 'provider.cjs');
  writeFileSync(executable, `
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input), params = request.params;
  fs.appendFileSync(params.path + ".started", JSON.stringify(request) + "\\n");
  const commit = () => {
    fs.writeFileSync(params.path + ".committed", params.value || "synthetic");
    process.stdout.write(JSON.stringify({ method: request.method, value: params.value }));
  };
  if (params.mode === "error") {
    process.stderr.write("synthetic-private-diagnostic");
    process.exit(7);
  } else if (params.mode === "overflow") process.stdout.write("x".repeat(1048577));
  else if (params.mode === "malformed") process.stdout.write("not-json");
  else if (params.mode === "late") setTimeout(commit, params.delay || 400);
  else commit();
});
`, { mode: 0o700 });
});
afterAll(() => rmSync(root,{recursive:true,force:true}));
async function started(path: string) {
  const deadline = Date.now()+3000;
  while (!existsSync(path+'.started') && Date.now()<deadline) await pause(10);
  expect(existsSync(path+'.started')).toBe(true);
}
it('real runner transports one request and returns only after its synthetic durable write', async()=>{
 const path=join(root,'success'); const value='synthetic approved memo';
 expect(await productivityRunner(executable)('notesAdd',{path,value})).toEqual({method:'notesAdd',value});
 expect(readFileSync(path+'.committed','utf8')).toBe(value);
 const rows=readFileSync(path+'.started','utf8').trim().split('\n');expect(rows).toHaveLength(1);
 expect(JSON.parse(rows[0]!)).toEqual({method:'notesAdd',params:{path,value}});
});
it('abort stops an acknowledged request before its pending durable write',async()=>{
 const path=join(root,'abort'); const controller=new AbortController();
 const outcome=productivityRunner(executable)('notesAdd',{path,mode:'late'},controller.signal).then(value=>({value,error:null}),error=>({value:null,error}));
 await started(path);controller.abort();await pause(650);
 const result=await outcome;
 expect(result.error).toBeInstanceOf(Error);
 expect(existsSync(path+'.committed')).toBe(false);
 expect(readFileSync(path+'.started','utf8').trim().split('\n')).toHaveLength(1);
});
it('oversized input is refused before any child receives a request',async()=>{
 const path=join(root,'input');
 await expect(productivityRunner(executable)('notesAdd',{path,value:'x'.repeat(262144)})).rejects.toThrow();
 expect(existsSync(path+'.started')).toBe(false);expect(existsSync(path+'.committed')).toBe(false);
});
it.each(['error','overflow','malformed'])('refuses %s without exposing private diagnostics or retrying',async mode=>{
 const path=join(root,mode);let error:unknown;try{await productivityRunner(executable)('notesSearch',{path,mode});}catch(e){error=e;}
 expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('synthetic-private-diagnostic');
 expect(readFileSync(path+'.started','utf8').trim().split('\n')).toHaveLength(1);
 expect(existsSync(path+'.committed')).toBe(false);
});
it('deadline stops acknowledged work before a later durable write',async()=>{
 const path=join(root,'timeout'); const outcome=productivityRunner(executable)('notesAdd',{path,mode:'late',delay:31000}).then(value=>({value,error:null}),error=>({value:null,error}));
 await started(path);const result=await outcome;await pause(1200);
 expect(result.error).toBeInstanceOf(Error);expect(existsSync(path+'.committed')).toBe(false);
 expect(readFileSync(path+'.started','utf8').trim().split('\n')).toHaveLength(1);
},35000);
