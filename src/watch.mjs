// Checks the site on a loop inside ONE GitHub Actions job.
//
// Why this exists: GitHub runs scheduled workflows on a best-effort basis and drops most of them
// under load. Measured on this repository 2026-09-18, of ~84 due 10-minute cron slots only 4 fired
// — roughly one check every 2 to 4.5 hours, however dense the cron. So the cron no longer does the
// pacing. It only STARTS this job; the job then checks every ~10 minutes on its own until just
// before GitHub's 6-hour job limit, and the next cron that fires waits as a warm standby
// (see the workflow's `concurrency`) and takes over when this job ends. That converts "one slot in
// ten fires" into real 10-minute coverage as long as a slot fires every ~6 hours, which it does.
//
//   MAX_RUN_MINUTES      how long to keep looping. 0 = one check then exit (manual/proof runs).
//   CHECK_EVERY_MINUTES  the gap between checks inside this job (default 10).
// Every other variable (SITE_URL, STATE_FILE, RESULT_FILE, RESEND_API_KEY, ALERT_TO, …) is passed
// straight through to the child processes, so this runner needs to know nothing about them.
//
// It never stops looping because a check failed: check.mjs exits 1 when the site is DOWN and 2 when
// the check itself could not run, and the whole point is to keep watching through both. The job's
// exit code mirrors only the LAST check, as the secondary (red-run) signal — after the state has
// been saved by the workflow's own always()-guarded step.

import { spawnSync } from "node:child_process";
import { loopPlan } from "./rules.mjs";

const MAX_RUN_MINUTES = Number(process.env.MAX_RUN_MINUTES ?? 330);
const CHECK_EVERY_MINUTES = Number(process.env.CHECK_EVERY_MINUTES ?? 10);
const startedAtMs = Date.now();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runOnce() {
  // check.mjs writes state/result; its exit code tells us what it found. Errors are printed by the
  // child (stdio inherited) — a non-zero exit is data here, not a reason to stop.
  const check = spawnSync(process.execPath, ["src/check.mjs"], { stdio: "inherit" });
  // notify.mjs emails only on a down/recovered change; a failure to send must not stop the loop.
  spawnSync(process.execPath, ["src/notify.mjs"], { stdio: "inherit" });
  return { down: check.status === 1 };
}

let checks = 0;
let last = { down: false };
for (;;) {
  last = runOnce();
  checks += 1;
  const plan = loopPlan({
    startedAtMs,
    nowMs: Date.now(),
    maxRunMinutes: MAX_RUN_MINUTES,
    intervalMinutes: CHECK_EVERY_MINUTES,
  });
  if (plan.stop) break;
  console.log(`watch: ${checks} check(s) done in this job; next in ${Math.round(plan.sleepMs / 60_000)} min`);
  await sleep(plan.sleepMs);
}

const ranForMinutes = Math.round(((Date.now() - startedAtMs) / 60_000) * 10) / 10;
console.log(`watch: job done — ${checks} check(s) over ${ranForMinutes} min; last check ${last.down ? "DOWN" : "up"}`);
// Red run only when the site is down right now, so it is the second signal alongside the email.
process.exit(last.down ? 1 : 0);
