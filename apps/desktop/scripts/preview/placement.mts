// Offscreen native-window + renderer geometry smoke test. Run after build:main and build:renderer.
import { app, BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { Rect } from "../../src/core/ui/overlayGeometry.js";

const root = join(import.meta.dirname, "../..");
const output = process.argv[2] ?? "/tmp/voice-placement-smoke";
app.dock?.hide();
app.on("window-all-closed", () => {});
void app.whenReady().then(async () => {
const { OverlayWindowController } = await import(pathToFileURL(join(root, "dist/node/main/overlayWindow.js")).href) as typeof import("../../src/main/overlayWindow.js");
const config = await import(pathToFileURL(join(root, "dist/node/core/config.js")).href) as typeof import("../../src/core/config.js");
mkdirSync(output, { recursive: true });
process.stdout.write(`Work area: ${JSON.stringify(screen.getPrimaryDisplay().workArea)}\n`);
const area = screen.getPrimaryDisplay().workArea;
const reports = [];
try {
  for (const [name, x, y] of [
    ["top-right", area.x + area.width - 2, area.y + 1],
    ["bottom-right", area.x + area.width - 2, area.y + area.height - 2],
    ["top-left", area.x + 1, area.y + 1],
    ["bottom-left", area.x + 1, area.y + area.height - 2],
  ] as const) {
    const window = new BrowserWindow({ show: false, transparent: true, frame: false, webPreferences: { offscreen: true, sandbox: false, contextIsolation: false, preload: join(import.meta.dirname, "placement-preload.cjs") } });
    window.webContents.on("console-message", (details) => { if (details.level === "error") process.stderr.write(`${details.message}\n`); });
    let visible = false;
    const surface = {
      setBounds: (bounds: Rect) => window.setBounds(bounds), getBounds: () => window.getBounds(),
      isVisible: () => visible, showInactive: () => { visible = true; window.showInactive(); }, hide: () => { visible = false; window.hide(); },
      setOpacity: (opacity: number) => window.setOpacity(opacity), setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean }) => window.setIgnoreMouseEvents(ignore, options),
    };
    const controller = new OverlayWindowController(surface, async () => ({ x, y, width: 1, height: 1 }));
    controller.update({ kind: "arming" });
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "listening" });
    await window.loadFile(join(root, "dist/renderer/overlay/index.html"));
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const started = Date.now(); const check = () => { if (window.placementReady) resolve(true); else if (Date.now() - started > 5000) reject(new Error('Renderer subscription not ready')); else setTimeout(check, 10); }; check(); })`);
    const base = { reveal: controller.reveal, phase: { kind: "listening" }, mode: "agent", level: 0.5, isHearing: true, hasVoice: true, isRetrying: false, language: "en", tip: "handsFree", hotkey: "rightOption", tools: ["compose", "answer"], readsWindow: true, connectors: ["calendar"], emailAppIcon: null, recentBubbles: [], runningBubble: null, chat: null, chatPlacement: null };
    const publish = async (extra = {}) => {
      const state = { ...base, overlayPlacement: controller.overlayPlacement, opensUpward: controller.opensUpward, bubblesFitUnder: controller.bubblesFitUnder, ...extra };
      await window.webContents.executeJavaScript(`window.setPlacementState(${JSON.stringify(state)})`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const bounds = window.getBounds();
      const local = await window.webContents.executeJavaScript(`(() => {
        const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        return { pill: rect(document.querySelector('.pill')), bubbles: [...document.querySelectorAll('.bubble')].map(rect), chat: document.querySelector('.chat') ? rect(document.querySelector('.chat')) : null };
      })()`) as { pill: Rect; bubbles: Rect[]; chat: Rect | null };
      return { bounds, pill: { x: bounds.x + local.pill.x + local.pill.width / 2, y: bounds.y + local.pill.y }, bubbles: local.bubbles.map((b) => ({ x: bounds.x + b.x, y: bounds.y + b.y })), chat: local.chat && { ...local.chat, x: bounds.x + local.chat.x, y: bounds.y + local.chat.y } };
    };
    const before = await publish();
    writeFileSync(join(output, `${name}-before.png`), (await window.webContents.capturePage()).toPNG());
    controller.update({ kind: "running", tool: "answer" }, true);
    const chat = { turns: [{ id: 1, request: "Synthetic request", reply: "Synthetic reply.", tool: "answer", questions: [] }], pendingRequest: null, questions: [], closesAt: null, touched: true, activity: null, confirmation: null, confirmationEvent: null, confirmationExpiresAt: null };
    const after = await publish({ chat, chatPlacement: controller.chatPlacement });
    writeFileSync(join(output, `${name}-geometry.json`), JSON.stringify({ area, before, after }, null, 2));
    assert.ok(Math.abs(before.pill.x - after.pill.x) < 1 && Math.abs(before.pill.y - after.pill.y) < 1, `${name}: pill shifted ${JSON.stringify({ before, after })}`);
    assert.equal(before.bubbles.length, after.bubbles.length);
    before.bubbles.forEach((point, i) => {
      const moved = after.bubbles[i];
      assert.ok(moved, `${name}: bubble ${i} missing`);
      assert.ok(Math.abs(point.x - moved.x) < 1 && Math.abs(point.y - moved.y) < 1, `${name}: bubble ${i} shifted`);
    });
    assert.ok(after.chat, `${name}: chat missing`);
    assert.ok(after.chat.x >= area.x + config.overlayEdgeInset - 1 && after.chat.x + after.chat.width <= area.x + area.width - config.overlayEdgeInset + 1, `${name}: chat clips horizontal inset`);
    const hidden = await publish({ chat, chatPlacement: controller.chatPlacement, tip: null });
    assert.deepEqual(hidden.pill, after.pill, `${name}: toggling tip moved pill`);
    assert.deepEqual(hidden.bubbles, after.bubbles, `${name}: toggling tip moved bubbles`);
    assert.deepEqual(hidden.chat, after.chat, `${name}: toggling tip moved chat`);
    writeFileSync(join(output, `${name}-chat.png`), (await window.webContents.capturePage()).toPNG());
    reports.push({ name, before, after });
    window.destroy();
  }
  writeFileSync(join(output, "geometry.json"), JSON.stringify(reports, null, 2));
  process.stdout.write(`PASS: four corners preserve pill/tool screen coordinates and chat inset; tip toggles move nothing. ${output}\n`);
  app.exit(0);
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  app.exit(1);
}

});
