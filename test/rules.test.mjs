import assert from "node:assert/strict";
import { test } from "node:test";
import { composeEmail } from "../src/notify.mjs";
import {
  ERROR_PAGE_TEXT,
  articleSlug,
  judgePage,
  judgeSite,
  nextArticles,
  parseSitemap,
  transition,
} from "../src/rules.mjs";

const body = "Business Growth Alliance ".repeat(40);
const healthy = { url: "https://x.test/", status: 200, text: body, hasH1: true };

test("parseSitemap reads every loc once, including entity-escaped ones", () => {
  const xml = `<urlset><url><loc>https://x.test/</loc></url><url><loc> https://x.test/blog/a </loc></url>
    <url><loc>https://x.test/blog/a</loc></url><url><loc>https://x.test/q?a=1&amp;b=2</loc></url></urlset>`;
  assert.deepEqual(parseSitemap(xml), ["https://x.test/", "https://x.test/blog/a", "https://x.test/q?a=1&b=2"]);
  assert.deepEqual(parseSitemap("not xml"), []);
});

test("articleSlug only matches a single segment under /blog", () => {
  assert.equal(articleSlug("https://x.test/blog/the-owner-bottleneck"), "the-owner-bottleneck");
  assert.equal(articleSlug("https://x.test/blog/the-owner-bottleneck/"), "the-owner-bottleneck");
  assert.equal(articleSlug("https://x.test/blog"), null);
  assert.equal(articleSlug("https://x.test/blog/a/b"), null);
  assert.equal(articleSlug("https://x.test/members/a"), null);
});

test("a healthy page has no problems", () => {
  assert.deepEqual(judgePage(healthy), []);
});

test("the 2026-09-16 crash: the site's own error page is a failure even with HTTP 200", () => {
  const problems = judgePage({ ...healthy, text: `${ERROR_PAGE_TEXT}\nSomething went wrong on our end.`, hasH1: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /didn't load/);
});

test("a blank page, a 404, a not-found page and a navigation error all fail", () => {
  assert.match(judgePage({ ...healthy, text: "   " }).join(), /nearly blank/);
  assert.match(judgePage({ ...healthy, status: 404 }).join(), /HTTP 404/);
  assert.match(judgePage({ ...healthy, text: `404 Page not found ${body}` }).join(), /Page not found/);
  assert.match(judgePage({ url: "u", error: "net::ERR_NAME_NOT_RESOLVED" }).join(), /did not load/);
});

test("script errors alone, or a page without an <h1> (/benchmarks), do not fail a page", () => {
  assert.deepEqual(judgePage({ ...healthy, scriptErrors: ["gtag is not defined"] }), []);
  assert.deepEqual(judgePage({ ...healthy, hasH1: false }), []);
});

const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];

test("the 2026-09-16 blog: articles that vanish from the sitemap and 404 are caught", () => {
  const problems = judgeSite({
    previous: { articles: nine },
    sitemapArticles: ["z"],
    blogListCount: 1,
    brokenArticles: nine,
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /9 article\(s\) seen on the last good check are no longer in the sitemap/);
  assert.match(problems[1], /9 article page\(s\) fail to load/);
});

test("/blog listing fewer articles than the sitemap is a failure; more is fine", () => {
  assert.match(
    judgeSite({ previous: null, sitemapArticles: nine, blogListCount: 1, brokenArticles: [] }).join(),
    /lists 1 article\(s\) but the sitemap has 9/,
  );
  assert.deepEqual(judgeSite({ previous: null, sitemapArticles: nine, blogListCount: 12, brokenArticles: [] }), []);
  // /blog itself failed: its page problem is reported elsewhere, not as a count mismatch
  assert.deepEqual(judgeSite({ previous: null, sitemapArticles: nine, blogListCount: null, brokenArticles: [] }), []);
});

test("a new article is not a problem; an empty sitemap is", () => {
  assert.deepEqual(
    judgeSite({ previous: { articles: nine }, sitemapArticles: [...nine, "new"], blogListCount: 10, brokenArticles: [] }),
    [],
  );
  assert.match(judgeSite({ previous: null, sitemapArticles: [], blogListCount: 0, brokenArticles: [] }).join(), /no articles/);
});

test("only a healthy run moves the article baseline", () => {
  assert.deepEqual(nextArticles({ previous: { articles: nine }, sitemapArticles: ["z"], healthy: false }), nine);
  assert.deepEqual(nextArticles({ previous: { articles: nine }, sitemapArticles: ["b", "a"], healthy: true }), ["a", "b"]);
  assert.deepEqual(nextArticles({ previous: null, sitemapArticles: ["z"], healthy: false }), []);
});

test("alerts fire on the change only", () => {
  assert.equal(transition(false, true), "down");
  assert.equal(transition(true, true), null);
  assert.equal(transition(true, false), "recovered");
  assert.equal(transition(false, false), null);
});

test("emails: one for down with the problems, one for recovery, none otherwise", () => {
  const base = { site: "https://x.test", checkedAt: "2026-09-17T10:00:00Z", pages: [{}, {}], problems: ["p1", "p2"] };
  const down = composeEmail({ ...base, change: "down" }, "https://run");
  assert.equal(down.subject, "DOWN: x.test");
  assert.match(down.text, /- p1\n- p2/);
  assert.match(down.text, /Run: https:\/\/run/);
  const up = composeEmail({ ...base, change: "recovered", downSince: "2026-09-17T09:00:00Z", problems: [] }, "");
  assert.equal(up.subject, "RECOVERED: x.test");
  assert.match(up.text, /failing since 2026-09-17T09:00:00Z/);
  assert.equal(composeEmail({ ...base, change: null }), null);
});
