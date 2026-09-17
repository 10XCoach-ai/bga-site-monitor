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
