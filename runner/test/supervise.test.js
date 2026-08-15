import { fileURLToPath } from "node:url";
// The `supervise` shim is the fleet protocol's reference SECOND producer: any
// command wrapped in it must be fully supervisable by the same tools as a
// workflow run. Proven here end-to-end with a real bash job — no Codex:
//
//   1. the wrapped job appears in `fleet status` (running, correct pid),
//   2. its @@ASK line becomes a pending question, pushed via --notify-cmd,
//   3. `fleet answer` delivers the reply to the job's STDIN,
//   4. exit 0 → result sidecar + journal + state completed,
//   5. an unanswered gate times out to its DEFAULT (never hangs),
//   6. a failing job ends up `stopped` (no fresh result).
//
//   node test/supervise.test.js

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

const SUP = fileURLToPath(new URL("../bin/supervise.js", import.meta.url));
const FLEET = fileURLToPath(new URL("../bin/fleet.js", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "wf-supervise-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pollFor = async (fn, what, ms = 10_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } };

try {
  // ── 1–4 · the answered-gate path ─────────────────────────────────────────
  const dir = join(ROOT, "deploy");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "deploy.mjs");
  writeFileSync(script, `
console.log("canary rollout…");
console.log('@@ASK {"id":"ship","question":"Canary clean. Promote to prod?","choices":["yes","no"],"default":"no","timeoutMs":30000}');
process.stdin.setEncoding("utf8");
process.stdin.once("data", (data) => {
  const answer = data.trim();
  console.log("supervisor said: " + answer);
  if (answer === "yes") console.log("promoted");
  process.exit(answer === "yes" ? 0 : 3);
});
`);

  const notifyLog = join(ROOT, "notify.log");
  const notifyScript = join(dir, "notify.mjs");
  writeFileSync(
    notifyScript,
    'import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], process.env.WORKFLOW_EVENT + "\\n");\n',
  );
  const notifyCommand = `"${process.execPath}" "${notifyScript}" "${notifyLog}"`;
  const child = spawn(process.execPath, [SUP, "--name", "deploy", "--notify-cmd", notifyCommand, "--", process.execPath, script], {
    cwd: dir, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const exited = new Promise((res) => child.on("exit", (code) => res(code)));

  const journal = join(dir, ".workflow-journal", "deploy.jsonl");
  const qPath = journal.replace(/\.jsonl$/, "") + ".questions.json";

  // the @@ASK line became a pending question
  const pending = await pollFor(() => readJson(qPath, []).find((q) => !q.answered), "the pending gate");
  assert.equal(pending.qid, "ship");
  assert.deepEqual(pending.choices, ["yes", "no"]);

  // fleet status sees a supervisable RUNNING job with the shim's pid
  const st = JSON.parse(spawnSync("node", [FLEET, "status", dir, "--json"], { encoding: "utf8" }).stdout);
  assert.equal(st.length, 1);
  assert.equal(st[0].state, "running");
  assert.equal(st[0].pid, child.pid);
  assert.equal(st[0].pendingQuestions[0]?.id, "human:ship#0");

  // the push channel fired
  const notified = await pollFor(() => {
    try { return readFileSync(notifyLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.event === "question"); } catch { return null; }
  }, "the question notify");
  assert.equal(notified.qid, "ship");

  // answer through the SAME channel as workflow gates → lands on the job's stdin
  const ans = spawnSync("node", [FLEET, "answer", "--journal", journal, "--id", "ship", "--answer", "yes"], { encoding: "utf8" });
  assert.equal(ans.status, 0, ans.stderr);

  assert.equal(await Promise.race([exited, sleep(15_000).then(() => "timeout")]), 0, `job should exit 0 (output: ${out})`);
  assert.match(out, /supervisor said: yes/, "the answer reached the job's stdin");
  assert.match(out, /promoted/);

  const entries = readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const gate = entries.find((e) => e.key === "human:ship#0");
  assert.equal(gate?.result, "yes");
  assert.equal(gate?.source, "live");
  const job = entries.find((e) => e.key === "job#0");
  assert.equal(job?.status, "completed");
  assert.equal(job?.result?.exitCode, 0);

  const st2 = JSON.parse(spawnSync("node", [FLEET, "status", dir, "--json"], { encoding: "utf8" }).stdout);
  assert.equal(st2[0].state, "completed");
  assert.equal(st2[0].result?.exitCode, 0);

  // ── 5–6 · the timeout path: default delivered, failing job → stopped ──────
  const dir2 = join(ROOT, "timeout");
  mkdirSync(dir2, { recursive: true });
  const script2 = join(dir2, "gate.mjs");
  writeFileSync(script2, `
console.log('@@ASK {"id":"go","question":"Proceed?","choices":["yes","no"],"default":"no","timeoutMs":900}');
process.stdin.setEncoding("utf8");
process.stdin.once("data", (data) => {
  const answer = data.trim();
  console.log("got: " + answer);
  process.exit(answer === "yes" ? 0 : 3);
});
`);
  const r2 = spawnSync(process.execPath, [SUP, "--name", "gate", "--", process.execPath, script2], { cwd: dir2, encoding: "utf8", timeout: 20_000 });
  assert.equal(r2.status, 3, "the default 'no' made the job exit 3");
  assert.match(r2.stdout, /got: no/, "the DEFAULT was delivered on timeout — gates never hang");

  const journal2 = join(dir2, ".workflow-journal", "gate.jsonl");
  const gate2 = readFileSync(journal2, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.key === "human:go#0");
  assert.equal(gate2?.source, "default");
  const st3 = JSON.parse(spawnSync("node", [FLEET, "status", dir2, "--json"], { encoding: "utf8" }).stdout);
  assert.equal(st3[0].state, "stopped", "a failed job (no fresh result, pid gone) reads as stopped");
} finally {
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

console.log("supervise (second protocol producer) checks passed ✓");
