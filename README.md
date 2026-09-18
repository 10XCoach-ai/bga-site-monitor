# bga-site-monitor

Opens **businessgrowth-alliance.com** in a real browser on a schedule and emails when it breaks and
when it comes back. It sends one email per change, not one per run.

It lives in its own repository on purpose. The site's repository syncs into Lovable's editor, and
nothing here should be able to disturb that sync.

## Why a real browser

On 2026-09-16 the site failed twice, and a plain HTTP check would most likely have passed both times:

1. **Every page crashed in the browser** for about 15 minutes. The server still answered, but React
   replaced each page with *"This page didn't load"*.
2. **The blog showed 1 of 9 articles** for about 87 minutes. Every page that loaded looked fine. The
   other 8 articles returned 404, and they had also dropped out of the sitemap.

## What counts as down

Every URL in `sitemap.xml` is opened in headless Chrome, plus `/`, `/blog`, and every article seen
on the last good check. The site is **down** when any of these is true:

- a page returns HTTP 400 or higher, fails to load, shows *"This page didn't load"* or
  *"Page not found"*, or has almost no text (under 400 characters)
- an article seen on the last good check is no longer in the sitemap, or no longer loads
- `/blog` (all its pages) lists fewer articles than the sitemap
- the sitemap lists no articles, or cannot be read
- the homepage renders without its header

Failing pages are opened a second time a minute later, so a deploy in progress does not alert anyone.
Uncaught script errors are printed in the log but do not count as down on their own, because
third-party scripts throw on healthy pages too.

## Setup (once)

In **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `RESEND_API_KEY` | a Resend key allowed to send from `send.businessgrowth-alliance.com` |
| Variable | `ALERT_TO` | comma-separated recipients |
| Variable | `ALERT_FROM` | optional; defaults to `BGA site monitor <no-reply@send.businessgrowth-alliance.com>` |

Without the secret, the check still runs and a failing run still turns red. GitHub emails a red
scheduled run to whoever last changed the schedule, so that becomes the only alert.

## Actions minutes — why this repository is public

Each scheduled run is now a **single job that keeps checking for about 5.5 hours** (see the next
section), and a fresh one takes over as soon as it ends, so in practice a runner is occupied almost
continuously — roughly 24 hours of runner time a day.

- **Public repositories** use standard runners at no cost in Actions minutes. That is why this one is public (decided 2026-09-17), and why a continuously-running job is affordable here.
- **Private repositories** share the organisation's free 2,000 minutes a month, **and so does the platform's production deploy**. A job that runs ~24 h/day would exhaust that in a day or two.
  - 🔴 **If this repository is ever made private, do NOT keep this design.** Lower `MAX_RUN_MINUTES` to `0` in `.github/workflows/monitor.yml` (back to one short check per scheduled run) and add a payment method, or the platform's production deploy will be blocked until the month resets.
- Only this code and the site's public address are visible. The Resend key is an Actions secret, and secrets are never shown.
## ⚠️ How often this ACTUALLY runs — read this before trusting it

**GitHub's cron is best-effort and drops most scheduled runs. So the cron no longer does the
checking — it only starts a job that then checks itself.**

The first design asked cron for a run every 10 minutes and let each run do one check. That failed in
the field. Two measurements, both on this repository:

| Cron asked for | Window | Runs **due** | Runs that **actually fired** |
|---|---|---|---|
| every 30 min | 2026-09-17, 13:07 → 19:37 | 14 | **1** (28 min late) |
| every 10 min | 2026-09-17 20:02 → 2026-09-18 10:00 | ~84 | **4** |

That is roughly one check every 2 to 4.5 hours, however dense the cron. The workflow was `active`,
the cron valid, on the default branch, public, not archived, not a fork. **No cause on our side.**
GitHub's scheduler simply drops the slots, and a denser cron does not change that.

**So the job now watches itself.** When a scheduled run does fire, it becomes a single job that runs
`src/check.mjs` **every ~10 minutes for about 5.5 hours** (`src/watch.mjs`), just under GitHub's
6-hour job limit. Inside one job that interval is reliable — it is a plain `setTimeout`, not the
scheduler. The cron only has to *start* one such job every ~6 hours, and the measurements show it
starts several a day. To make the handover seamless, the dense cron is kept: at any moment a fresh
run is queued as a **warm standby** (`concurrency` keeps exactly one pending and never cancels the
running one), and it takes over the instant the running job ends. The result is near-continuous
10-minute coverage instead of a check every few hours.

Still built in, unchanged:

- **Every check reports the gap since the last one**, and a DOWN email carries it. The run log says
  `last checked N minutes ago`; if the gap is more than three intervals it says plainly that *the
  site was not being watched* for that period, and that this is the monitor's gap, not the site's.

🔴 **What this still cannot promise:**

- **If GitHub stops firing the cron entirely for more than ~6 hours**, the running job ends, no
  standby is queued, and coverage stops until the next cron fires. Nothing here can alert you to
  that from the outside — the alert would have to come from a machine we control, and there isn't
  one. The gap report only tells you *after the fact*, on the next run that happens.
- **If GitHub's infrastructure kills a running job** (not our `timeout`), its "save state" step does
  not run, so the next job starts from older state. That is not silent — the next job's coverage line
  reports the blind window correctly — but that window did happen.
- Treat this as **"we will almost certainly notice within an hour, and usually within ~10 minutes"**,
  never as a guarantee.

- ⚠️ GitHub turns off scheduled workflows on a public repository after **60 days without a commit**. It emails a warning first. Re-enable the workflow from the Actions tab, or push any commit.

### Proving the loop on demand

You do not have to wait for a scheduled run to see the loop work. **Actions → Site check → Run
workflow**, set `loop_minutes` to e.g. `15` and `check_every_minutes` to `3`. That runs the watcher
for 15 minutes doing a check every 3 — several checks in one run — against an **isolated state**
(under `manual/`) that never touches the real monitor's cache. The run log shows each check and its
coverage line.

## When an article is removed on purpose

The monitor remembers the articles from the last good check. A deliberate removal therefore reads as
"down" until you accept it: **Actions → Site check → Run workflow → tick "An article was removed on
purpose"**.

## Run it locally

```bash
npm ci
npm test                      # the rules, no browser
node src/check.mjs            # the real site; state goes to state/state.json
SITE_URL=http://localhost:8787 node src/check.mjs
```

Exit code `0` = up, `1` = down, `2` = the check itself could not run.
