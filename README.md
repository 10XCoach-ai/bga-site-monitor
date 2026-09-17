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

It asks for a run **every 10 minutes**, which is up to 144 runs a day, or roughly 4,000–8,600 minutes a month if GitHub honoured every one (it does not — see below).

- **Public repositories** use standard runners at no cost in Actions minutes. That is why this one is public (decided 2026-09-17).
- **Private repositories** share the organisation's free 2,000 minutes a month, **and so does the platform's production deploy**. September 2026 was already on course for ~1,550 without this check. Running it privately at this frequency would risk stopping deploys until the month resets.
  - ⚠️ **If this repository is ever made private, lower the schedule in `.github/workflows/monitor.yml` first**, or add a payment method. At 6 requested runs an hour this would exhaust the free allowance in days.
- Only this code and the site's public address are visible. The Resend key is an Actions secret, and secrets are never shown.
## ⚠️ How often this ACTUALLY runs — read this before trusting it

**GitHub's cron is best-effort and drops runs freely. This check is not guaranteed to run at all.**

Measured on 2026-09-17, the repository's first day, on the original every-30-minutes cron:

| | |
|---|---|
| Scheduled runs **due** (13:07 → 19:37) | **14** |
| Scheduled runs that **actually ran** | **1** |
| How late that one was | **28 minutes** |

The workflow was `active`, the cron expression was valid, it was on the default branch, the repository
was public, not archived and not a fork, and the 60-day auto-disable cannot apply to a repository
seven hours old. **No cause was found on our side.** It is GitHub's scheduler, which we cannot see into.

Two things follow, and both are built in:

1. **The schedule asks for every 10 minutes** (`3,13,23,33,43,53`), off the congested :00/:30 marks.
   The point is not to check that often — it is that six requests an hour survive a scheduler that
   keeps roughly one in ten.
2. **Every run reports the gap since the last one**, and a DOWN email carries it. A monitor that
   silently stops running looks exactly like a monitor that keeps passing, and that is the one
   failure a monitor must not have. So the run log says `last checked N minutes ago`, and if the gap
   is more than three intervals it says plainly that *the site was not being watched* for that
   period — and that this is the scheduler's fault, not the site's.

🔴 **What this still does not give you:** if GitHub stops running the workflow entirely, nothing here
can tell you — the alert would have to come from a machine we control, and there isn't one. The gap
report only tells you *after the fact*, on the next run that does happen. Treat this as "we will
probably notice within an hour", never as "we will know within 10 minutes".

- ⚠️ GitHub turns off scheduled workflows on a public repository after **60 days without a commit**. It emails a warning first. Re-enable the workflow from the Actions tab, or push any commit.

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
