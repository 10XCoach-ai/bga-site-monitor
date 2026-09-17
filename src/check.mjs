// Opens the site in a real browser and decides whether it is up.
//
// Usage: node src/check.mjs
//   SITE_URL        default https://businessgrowth-alliance.com
//   STATE_FILE      default state/state.json (read, then rewritten)
//   RESULT_FILE     default result.json (what notify.mjs reads)
//   CHROME_PATH     a Chrome/Chromium binary; found automatically on GitHub's runners and macOS
//   RETRY_DELAY_MS  default 60000 — failed pages are opened once more after this wait
//   ACCEPT_ARTICLES "true" = take today's sitemap as the new article baseline (after a deliberate removal)
//
// Exit code: 0 up, 1 down, 2 the check itself could not run (no browser, no network).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import puppeteer from "puppeteer-core";
import { articleSlug, judgePage, judgeSite, nextArticles, parseSitemap, transition } from "./rules.mjs";

const SITE_URL = (process.env.SITE_URL || "https://businessgrowth-alliance.com").replace(/\/+$/, "");
const STATE_FILE = process.env.STATE_FILE || "state/state.json";
const RESULT_FILE = process.env.RESULT_FILE || "result.json";
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS ?? 60_000);
const ACCEPT_ARTICLES = process.env.ACCEPT_ARTICLES === "true";
const PAGE_TIMEOUT_MS = 45_000;
// Let client-side rendering finish (and fail, if it is going to) after the network settles.
const SETTLE_MS = 2_500;
const MAX_BLOG_PAGES = 10;

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p) => p && existsSync(p));
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function observe(browser, url) {
  const page = await browser.newPage();
  const scriptErrors = [];
  page.on("pageerror", (e) => scriptErrors.push(String(e?.message ?? e).slice(0, 200)));
  try {
    const response = await page.goto(url, { waitUntil: "networkidle2", timeout: PAGE_TIMEOUT_MS });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const seen = await page.evaluate(() => {
      const slugs = new Set();
      for (const a of document.querySelectorAll('a[href*="/blog/"]')) {
        const m = new URL(a.href, location.href).pathname.match(/^\/blog\/([^/?#]+)\/?$/);
        if (m) slugs.add(m[1]);
      }
      return {
        text: document.body?.innerText ?? "",
        hasH1: Boolean(document.querySelector("h1")?.innerText?.trim()),
        hasHeader: Boolean(document.querySelector("header")),
        articleLinks: [...slugs],
      };
    });
    return { url, status: response?.status() ?? null, ...seen, scriptErrors };
  } catch (error) {
    return { url, error: String(error?.message ?? error).slice(0, 200), scriptErrors };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const previous = readState();

  const executablePath = chromePath();
  if (!executablePath) throw new Error("no Chrome found; set CHROME_PATH");

  // The sitemap decides which pages exist. If it cannot be read, check the pages every site has.
  let urls;
  let sitemapProblem = null;
  try {
    const res = await fetch(`${SITE_URL}/sitemap.xml`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    urls = parseSitemap(await res.text());
    if (!urls.length) throw new Error("no URLs in it");
  } catch (error) {
    sitemapProblem = `sitemap.xml could not be read (${error.message})`;
    urls = [`${SITE_URL}/`, `${SITE_URL}/blog`];
  }
  // Taken from the sitemap alone, before remembered articles are added to the list below.
  const sitemapArticles = sitemapProblem ? [] : urls.filter((u) => articleSlug(u)).map(articleSlug);
  // Always check the homepage and the blog index, and every article remembered from the last good run,
  // even when today's sitemap has lost them.
  for (const path of ["/", "/blog"]) if (!urls.some((u) => new URL(u).pathname === path)) urls.push(SITE_URL + path);
  // ACCEPT_ARTICLES forgets the remembered list, so an accepted removal is not checked again.
  for (const slug of ACCEPT_ARTICLES ? [] : (previous?.articles ?? [])) {
    const url = `${SITE_URL}/blog/${encodeURIComponent(slug)}`;
    if (!urls.some((u) => articleSlug(u) === slug)) urls.push(url);
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const pages = new Map();
  try {
    for (const url of urls) pages.set(url, await observe(browser, url));

    // /blog is paginated (7 per page on 2026-09-17). Follow its "All" pages until one adds nothing new,
    // so the article count compares like with like against the sitemap.
    const blogUrl = urls.find((u) => new URL(u).pathname === "/blog");
    const blogFirst = pages.get(blogUrl);
    if (blogFirst && judgePage(blogFirst).length === 0) {
      const all = new Set(blogFirst.articleLinks);
      for (let n = 2; n <= MAX_BLOG_PAGES; n++) {
        const next = await observe(browser, `${SITE_URL}/blog?category=All&page=${n}`);
        const before = all.size;
        for (const slug of next.articleLinks ?? []) all.add(slug);
        if (all.size === before) break;
      }
      blogFirst.articleLinks = [...all];
    }

    // One retry for anything that failed, after a pause: a deploy in progress or a network blip
    // should not wake anybody up.
    const failed = [...pages.values()].filter((o) => judgePage(o).length).map((o) => o.url);
    if (failed.length && RETRY_DELAY_MS > 0) {
      console.log(`${failed.length} page(s) failed; retrying in ${RETRY_DELAY_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      for (const url of failed) pages.set(url, await observe(browser, url));
    }
  } finally {
    await browser.close();
  }

  const report = [...pages.values()].map((o) => ({
    url: o.url,
    status: o.status ?? null,
    problems: judgePage(o),
    scriptErrors: o.scriptErrors,
  }));
  const home = pages.get(urls.find((u) => new URL(u).pathname === "/"));
  const blog = pages.get(urls.find((u) => new URL(u).pathname === "/blog"));
  const brokenArticles = report.filter((r) => articleSlug(r.url) && r.problems.length).map((r) => articleSlug(r.url));
  const blogHealthy = blog && judgePage(blog).length === 0;

  const siteProblems = [
    ...(sitemapProblem ? [sitemapProblem] : []),
    ...judgeSite({
      previous: ACCEPT_ARTICLES ? null : previous,
      sitemapArticles,
      blogListCount: blogHealthy ? blog.articleLinks.length : null,
      brokenArticles,
    }),
  ];
  if (home && judgePage(home).length === 0 && !home.hasHeader) siteProblems.push("the homepage has no header");

  const pageProblems = report.filter((r) => r.problems.length).map((r) => `${r.url}: ${r.problems.join("; ")}`);
  const problems = [...pageProblems, ...siteProblems];
  const down = problems.length > 0;
  const change = transition(Boolean(previous?.down), down);

  const state = {
    checkedAt: startedAt,
    down,
    downSince: down ? (previous?.down ? previous.downSince : startedAt) : null,
    articles: nextArticles({ previous: ACCEPT_ARTICLES ? null : previous, sitemapArticles, healthy: !down }),
  };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  const result = { site: SITE_URL, checkedAt: startedAt, down, change, downSince: state.downSince, problems, pages: report };
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  console.log(`${SITE_URL}: ${down ? "DOWN" : "up"} — ${report.length} pages checked${change ? `, change: ${change}` : ""}`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  const noisy = report.filter((r) => r.scriptErrors.length);
  for (const r of noisy) console.log(`  (script errors, not counted) ${r.url}: ${r.scriptErrors[0]}`);
  return down ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`the check could not run: ${error?.stack ?? error}`);
    process.exit(2);
  },
);
