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

## ⚠️ Decide before merging: Actions minutes

The schedule only starts once this is on the default branch. **It ships at every 2 hours** (about
360–720 minutes a month), because that is safe in either case. Every 30 minutes, which is what an
outage alert really wants, is 48 runs a day, **roughly 1,400–2,900 minutes a month**.

- **Private repository:** those minutes come out of the organisation's free 2,000 a month. That quota
  is shared with every other private repository, **including the platform's production deploy**.
  September 2026 was already on course for ~1,500 minutes without this.
  - To run every 30 minutes privately, add a spending limit or payment method first.
- **Public repository:** standard runners cost no minutes, so every 30 minutes is free. The repository would expose this code and
  the site's public address, but no secrets: Actions secrets are never shown.
  - Note: GitHub turns off scheduled workflows on a public repository after 60 days without a commit.
    It emails a warning first.

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
