// Pure decisions, kept apart from the browser so they can be tested without one.

/** Text the site shows when React has given up on the page (src/routes/__root.tsx, src/lib/error-page.ts). */
export const ERROR_PAGE_TEXT = "This page didn't load";
export const NOT_FOUND_TEXT = "Page not found";

/** A page with less visible text than this is treated as blank. The smallest real page carries several thousand. */
export const MIN_TEXT_CHARS = 400;

/** Every <loc> in a sitemap, in order, de-duplicated. */
export function parseSitemap(xml) {
  const urls = [];
  for (const match of String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = match[1].replace(/&amp;/g, "&");
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/** "/blog/<slug>" → "<slug>", anything else → null. */
export function articleSlug(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    path = String(url);
  }
  const match = path.match(/^\/blog\/([^/?#]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * What is wrong with one rendered page, as short sentences. Empty = healthy.
 *
 * `observation` is what the browser saw:
 *   { url, status, text, hasHeader, articleLinks, error }
 * Uncaught script errors are reported by the caller but are NOT a failure on their own: third-party
 * scripts throw on healthy pages, and a crash that matters shows up as the error page or a blank page.
 */
export function judgePage(observation) {
  const problems = [];
  const { status, text = "", error } = observation;
  if (error) {
    problems.push(`did not load (${error})`);
    return problems;
  }
  if (typeof status === "number" && status >= 400) problems.push(`HTTP ${status}`);
  if (text.includes(ERROR_PAGE_TEXT)) problems.push(`shows "${ERROR_PAGE_TEXT}"`);
  else if (text.includes(NOT_FOUND_TEXT)) problems.push(`shows "${NOT_FOUND_TEXT}"`);
  else if (text.trim().length < MIN_TEXT_CHARS) problems.push(`nearly blank (${text.trim().length} characters of text)`);
  // A missing <h1> is not checked: /benchmarks has none by design, and the text checks above already
  // catch a page that failed to render.
  return problems;
}

/**
 * Whole-site problems that no single page shows.
 *
 * On 2026-09-16 every page "worked": the blog listed one article and the other eight simply 404'd,
 * and the sitemap shrank with it. The only way to see that is to remember what was there before.
 *
 *   previous  — the last run's state ({ articles: string[] }) or null on the first run
 *   sitemapArticles — slugs in today's sitemap
 *   blogListCount — distinct articles linked from /blog and its later pages (null when /blog itself failed)
 *   brokenArticles — slugs whose page failed today (from the sitemap or from `previous`)
 */
export function judgeSite({ previous, sitemapArticles, blogListCount, brokenArticles }) {
  const problems = [];
  const known = previous?.articles ?? [];
  const missing = known.filter((slug) => !sitemapArticles.includes(slug));
  if (missing.length) {
    problems.push(
      `${missing.length} article(s) seen on the last good check are no longer in the sitemap: ${missing.join(", ")}`,
    );
  }
  if (brokenArticles.length) {
    problems.push(`${brokenArticles.length} article page(s) fail to load: ${brokenArticles.join(", ")}`);
  }
  if (blogListCount !== null && sitemapArticles.length > 0 && blogListCount < sitemapArticles.length) {
    problems.push(`/blog lists ${blogListCount} article(s) but the sitemap has ${sitemapArticles.length}`);
  }
  if (sitemapArticles.length === 0) problems.push("the sitemap lists no articles");
  return problems;
}

/**
 * Which articles to remember for next time.
 *
 * Only a healthy run moves the baseline — otherwise a broken site would teach the monitor that the
 * broken state is normal and it would go quiet after one alert. A deliberately deleted article
 * therefore alerts once; see the README for how to accept it.
 */
export function nextArticles({ previous, sitemapArticles, healthy }) {
  if (!healthy) return previous?.articles ?? [];
  return [...sitemapArticles].sort();
}

/**
 * Whether to send anything. Alerts go out on the change only, never on every failing run.
 *   previousDown — was the site down at the last run (false on the first run)
 *   down — is it down now
 */
export function transition(previousDown, down) {
  if (down && !previousDown) return "down";
  if (!down && previousDown) return "recovered";
  return null;
}

/**
 * How long the site went unwatched, and whether that is worth saying out loud.
 *
 * ⚠️ This is NOT a judgement about the site. It is a judgement about the MONITOR. GitHub runs
 * scheduled workflows on a best-effort basis and drops them freely under load: on 2026-09-17 this
 * repository was measured at **1 scheduled run out of 14 due** over its first seven hours. A check
 * that silently does not run looks exactly like a check that keeps passing, which is the one failure
 * a monitor must never have. So every run reports the gap since the last one, and a DOWN email
 * carries it too — an alert is only as fresh as the check behind it.
 *
 *   previousCheckedAt — ISO string from the last run's state, or null/undefined on the first run
 *   checkedAt — ISO string for this run
 *   expectedEveryMinutes — the schedule's interval
 *   toleranceFactor — how many intervals may pass before it is worth reporting
 *
 * Returns { minutes, blind, note } — `minutes` is null on the first run; `note` is null when the
 * gap is unremarkable.
 */
export function judgeCoverage({ previousCheckedAt, checkedAt, expectedEveryMinutes, toleranceFactor = 3 }) {
  const then = Date.parse(previousCheckedAt ?? "");
  const now = Date.parse(checkedAt ?? "");
  if (!Number.isFinite(then) || !Number.isFinite(now)) return { minutes: null, blind: false, note: null };
  const minutes = Math.round(((now - then) / 60_000) * 10) / 10;
  // A clock that runs backwards (a re-run of an older state) is not a gap.
  if (minutes < 0) return { minutes: null, blind: false, note: null };
  const allowed = expectedEveryMinutes * toleranceFactor;
  if (minutes <= allowed) return { minutes, blind: false, note: null };
  const hours = minutes / 60;
  const spell = hours >= 1 ? `${hours.toFixed(1)} hours` : `${Math.round(minutes)} minutes`;
  return {
    minutes,
    blind: true,
    note:
      `nobody checked this site for ${spell} before this run ` +
      `(the schedule asks for every ${expectedEveryMinutes} minutes). ` +
      `The site was not being watched for that period — this is GitHub's scheduler, not the site.`,
  };
}

/**
 * How the long-running watcher paces itself inside a single GitHub Actions job.
 *
 * GitHub drops most scheduled runs (measured 2026-09-18: 4 of ~84 due 10-minute slots fired), so a
 * cron that asks for a check every 10 minutes delivers one every few hours. The fix is not a denser
 * cron — GitHub will not honour it — but a job that, once started, keeps checking on its own until
 * just before GitHub's 6-hour job limit. The cron only has to START one such job every few hours,
 * which the measurement shows it does.
 *
 * This is the one timing decision, kept pure so it can be tested without spawning anything.
 *   startedAtMs      — Date.now() when the job's loop began
 *   nowMs            — Date.now() after the check that just finished
 *   maxRunMinutes    — how long the job may keep looping; 0 means a single check then stop
 *   intervalMinutes  — the gap between checks inside the job
 *
 * Returns { stop, sleepMs }. We stop *before* a sleep-plus-check would run past the budget, so the
 * job always ends on its own and its "save state" step runs — well inside GitHub's hard limit.
 */
export function loopPlan({ startedAtMs, nowMs, maxRunMinutes, intervalMinutes }) {
  if (!(maxRunMinutes > 0)) return { stop: true, sleepMs: 0 };
  const elapsedMinutes = (nowMs - startedAtMs) / 60_000;
  if (elapsedMinutes + intervalMinutes >= maxRunMinutes) return { stop: true, sleepMs: 0 };
  return { stop: false, sleepMs: Math.round(intervalMinutes * 60_000) };
}
