// The test from development-notes/preroll-and-catch-up.md.  Not part of the app.
//
// Opens the video editor in a visible Chrome window, then measures:
//   A. Preroll -200 s:  how long until caught up, and the longest gap between frames.
//   B. Seek to 200 s on the timeline:  the same.  Must reach exactly the same state as A.
//   C. getFramePromises() for 150 s:  how long recording would wait, and whether the GUI stayed live.
//   D. Normal playback:  3 s of play should move the program 3 s.
//
// Setup, in a scratch folder outside this project:  npm i playwright-core
// Run the dev server on the port below (any port but your editor's, so its saved work isn't touched),
// then:  node catch-up-test.mjs <full|seek> <label>
import { chromium } from "playwright-core";
const mode = process.argv[2] ?? "full";
const label = process.argv[3] ?? "";
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: false,
  args: ["--window-size=1600,1000"],
});
const page = await browser.newPage({ viewport: { width: 1580, height: 900 } });
const logs = [];
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto("http://localhost:5179/");
await page.waitForFunction(() => window.app, null, { timeout: 30000 });
await page.click("#openVideoEditor");
await page.waitForFunction(() => window.philDebug?.demos?.().length, null, { timeout: 60000 });
await page.waitForTimeout(3000);
// Helpers in the page:  watch frames, wait until the program stops racing, read the state.
await page.evaluate(() => {
  const w = window;
  w.frameLog = [];
  const tick = (now) => { w.frameLog.push([now, w.app.demoRemaining()]); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  w.settle = async (start) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 50));
      const recent = w.frameLog.filter(([t]) => t > start).slice(-30);
      if (recent.length >= 30 && !recent.some(([, r], i) => i > 0 && Math.abs(r - recent[i - 1][1]) > 0.05)) {
        const during = w.frameLog.filter(([t]) => t > start && t <= recent[0][0]);
        let maxGap = 0;
        for (let i = 1; i < during.length; i++) maxGap = Math.max(maxGap, during[i][0] - during[i - 1][0]);
        return { seconds: +((recent[0][0] - start) / 1000).toFixed(2), maxFrameGapMs: Math.round(maxGap) };
      }
      if (performance.now() - start > 90000) return { seconds: "timeout" };
    }
  };
  w.state = () => JSON.stringify({ z: w.app.player.z, w: w.app.player.w, remaining: +w.app.demoRemaining().toFixed(6) });
  w.seek = (seconds) => {
    const input = document.getElementById("playPositionSeconds");
    input.value = String(seconds);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
});
const results = {};
if (mode == "full") {
  results.A_preroll = await page.evaluate(async () => {
    const start = performance.now();
    window.philDebug.demos()[0].prerollScalar.value = -200000;
    const r = await window.settle(start);
    return { ...r, state: window.state() };
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window.philDebug.demos()[0].prerollScalar.value = 0));
  await page.waitForTimeout(1500);
}
results.B_seek200 = await page.evaluate(async () => {
  const start = performance.now();
  window.seek(200);
  const r = await window.settle(start);
  return { ...r, state: window.state() };
});
if (mode == "full") {
  results.sameState = results.A_preroll.state == results.B_seek200.state;
  await page.waitForTimeout(1500);
  // Recording path:  ask for frame promises far back, which restarts and catches up in the background.
  results.C_framePromises = await page.evaluate(async () => {
    const demo = window.philDebug.demos()[0];
    const set = new Set();
    const start = performance.now();
    demo.getFramePromises(150000, set);
    const count = set.size;
    await Promise.all([...set]);
    const ms = performance.now() - start;
    const during = window.frameLog.filter(([t]) => t > start && t < start + ms);
    let maxGap = 0;
    for (let i = 1; i < during.length; i++) maxGap = Math.max(maxGap, during[i][0] - during[i - 1][0]);
    return { promises: count, seconds: +(ms / 1000).toFixed(2), framesDrawnWhileWaiting: during.length, maxFrameGapMs: Math.round(maxGap), remaining: +window.app.demoRemaining().toFixed(3) };
  });
  await page.waitForTimeout(1500);
  // Normal playback from 0.
  results.D_play = await page.evaluate(async () => {
    window.seek(0);
    await new Promise((r) => setTimeout(r, 1500));
    const before = window.app.demoRemaining();
    const play = [...document.querySelectorAll("input[type=checkbox]")].find((b) => b.parentElement?.textContent?.includes("Play"));
    play.click();
    const start = performance.now();
    await new Promise((r) => setTimeout(r, 3000));
    play.click();
    const elapsed = (performance.now() - start) / 1000;
    return { playedSeconds: +elapsed.toFixed(2), programAdvancedSeconds: +(before - window.app.demoRemaining()).toFixed(2) };
  });
}
console.log(label);
for (const [k, v] of Object.entries(results)) console.log(" ", k, typeof v == "object" ? JSON.stringify(v) : v);
await page.waitForTimeout(2000);
console.log(logs.join("\n") || "no errors");
await browser.close();
