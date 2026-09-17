// Sends one email when the site goes down and one when it comes back. Nothing in between.
//
// Usage: node src/notify.mjs
//   RESULT_FILE     default result.json (written by check.mjs)
//   RESEND_API_KEY  secret; without it nothing is emailed and the failed run is the only signal
//   ALERT_TO        comma-separated recipients
//   ALERT_FROM      default "BGA site monitor <no-reply@send.businessgrowth-alliance.com>"
//   RUN_URL         link to this run, added to the email
//   GITHUB_STEP_SUMMARY  set by Actions; the result is written there too

import { appendFileSync, readFileSync } from "node:fs";

const RESULT_FILE = process.env.RESULT_FILE || "result.json";
const FROM = process.env.ALERT_FROM || "BGA site monitor <no-reply@send.businessgrowth-alliance.com>";
const TO = (process.env.ALERT_TO || "").split(",").map((s) => s.trim()).filter(Boolean);

export function composeEmail(result, runUrl) {
  const host = new URL(result.site).host;
  const lines = [];
  let subject;
  if (result.change === "down") {
    subject = `DOWN: ${host}`;
    lines.push(`${host} failed its check at ${result.checkedAt} (checked twice, a minute apart).`, "", "What is wrong:");
    for (const p of result.problems) lines.push(`- ${p}`);
  } else if (result.change === "recovered") {
    subject = `RECOVERED: ${host}`;
    lines.push(`${host} passed its check again at ${result.checkedAt}.`);
    if (result.downSince) lines.push(`It had been failing since ${result.downSince}.`);
  } else {
    return null;
  }
  lines.push("", `Pages checked: ${result.pages.length}`);
  if (runUrl) lines.push(`Run: ${runUrl}`);
  return { subject, text: lines.join("\n") };
}

function summary(result) {
  const out = [`## ${result.site}: ${result.down ? "❌ DOWN" : "✅ up"}`, ""];
  if (result.change) out.push(`**Change:** ${result.change}`, "");
  for (const p of result.problems) out.push(`- ${p}`);
  out.push("", "| Page | HTTP | Result |", "|---|---|---|");
  for (const page of result.pages) {
    out.push(`| ${page.url} | ${page.status ?? "—"} | ${page.problems.length ? page.problems.join("; ") : "ok"} |`);
  }
  return out.join("\n") + "\n";
}

async function main() {
  const result = JSON.parse(readFileSync(RESULT_FILE, "utf8"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(result));

  const email = composeEmail(result, process.env.RUN_URL);
  if (!email) {
    console.log("no change since the last run; nothing to send");
    return;
  }
  if (!process.env.RESEND_API_KEY || !TO.length) {
    console.log(`would send "${email.subject}", but RESEND_API_KEY or ALERT_TO is not set`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: TO, subject: email.subject, text: email.text }),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  console.log(`sent "${email.subject}" to ${TO.length} recipient(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
