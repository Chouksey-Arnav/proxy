// FILE B: api/proxy.js
// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function — Node.js 18.x
//
// This is the core of the proxy. Vercel automatically exposes any file inside
// /api/ as a serverless HTTP endpoint at the matching path. This file becomes:
//   GET  https://your-app.vercel.app/api/proxy?q=search+term
//   GET  https://your-app.vercel.app/api/proxy?url=https%3A%2F%2F...
//
// It uses Node 18's native fetch() — no npm packages required.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {

  // ── CORS Pre-flight ────────────────────────────────────────────────────────
  // Allow same-site fetch() calls from the frontend.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).send("Method Not Allowed");
  }

  // ── Base URL ───────────────────────────────────────────────────────────────
  // We specifically use html.duckduckgo.com — NOT duckduckgo.com.
  // The /html/ endpoint returns a pure server-rendered HTML page with no
  // client-side JS required to populate results. This makes it trivially
  // easy to fetch, transform, and relay. The standard JS-heavy DDG page would
  // require executing JavaScript to get results, which a server-side fetch
  // cannot do.
  const BASE_DDG = "https://html.duckduckgo.com";

  // ── Parameter Parsing ──────────────────────────────────────────────────────
  // Two modes:
  //   ?q=search+term   → build a fresh DDG search URL
  //   ?url=https://…   → proxy a specific DDG URL (for pagination links)
  const { q, url } = req.query;

  let targetUrl;

  if (q) {
    // Primary mode: fresh search
    targetUrl = `${BASE_DDG}/html/?q=${encodeURIComponent(q)}&kl=us-en`;

  } else if (url) {
    // Secondary mode: follow a DDG link (next page, etc.)
    // SECURITY: We strictly validate that the URL belongs to duckduckgo.com.
    // This prevents our proxy from being used as an open relay for arbitrary sites.
    let decoded;
    try {
      decoded = decodeURIComponent(url);
      const parsed = new URL(decoded);
      if (!parsed.hostname.endsWith("duckduckgo.com")) {
        return res.status(403).send(`
          <html><body style="font-family:monospace;padding:2rem;background:#111;color:#f87171;">
            <h2>403 — Forbidden</h2>
            <p>This proxy only relays DuckDuckGo URLs.</p>
            <p>Rejected host: <code>${parsed.hostname}</code></p>
          </body></html>
        `);
      }
      targetUrl = parsed.toString();
    } catch (e) {
      return res.status(400).send("Invalid URL parameter.");
    }

  } else {
    return res.status(400).send(`
      <html><body style="font-family:monospace;padding:2rem;background:#111;color:#f87171;">
        <h2>400 — Bad Request</h2>
        <p>Provide either <code>?q=your+search</code> or <code>?url=https://...</code></p>
      </body></html>
    `);
  }

  // ── Upstream Fetch ─────────────────────────────────────────────────────────
  // We impersonate a real browser with a full set of headers. DuckDuckGo
  // will return an empty or error page if it detects a bot-like request
  // (missing Accept headers, missing User-Agent, etc.).
  //
  // Key headers explained:
  //   User-Agent     → Makes DDG think we're Chrome on Windows
  //   Accept         → Signals we want HTML (DDG checks this)
  //   Accept-Encoding: identity → Tells DDG not to gzip the response.
  //                               If we received gzip, we'd need to decompress
  //                               it before running string replacements. By
  //                               requesting 'identity', we get plain text and
  //                               can manipulate it directly.
  //   Referer        → Makes the request look like it came from DDG itself

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/124.0.0.0 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9," +
          "image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",      // ← Critical: no compression
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": "https://duckduckgo.com/",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
      },
      redirect: "follow",
      // 8-second timeout — prevents Vercel function from hanging forever
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
    return res.status(504).send(`
      <html><body style="font-family:monospace;padding:2rem;background:#111;color:#f87171;">
        <h2>${isTimeout ? "504 — Gateway Timeout" : "502 — Bad Gateway"}</h2>
        <p>${isTimeout ? "DuckDuckGo did not respond in time." : err.message}</p>
        <a href="javascript:window.close()" style="color:#60a5fa;">Close Tab</a>
      </body></html>
    `);
  }

  if (!upstreamResponse.ok) {
    return res.status(upstreamResponse.status).send(`
      <html><body style="font-family:monospace;padding:2rem;background:#111;color:#f87171;">
        <h2>Upstream Error: ${upstreamResponse.status} ${upstreamResponse.statusText}</h2>
        <p>DuckDuckGo returned an unexpected response.</p>
      </body></html>
    `);
  }

  // ── HTML Transformation Pipeline ───────────────────────────────────────────
  // We receive raw DDG HTML and run it through a series of transformations
  // before sending it to the client. Order matters.
  let html = await upstreamResponse.text();

  // TRANSFORM 1: Strip DDG's Content-Security-Policy <meta> tags
  // DDG embeds CSP rules as meta tags inside the HTML. These would block our
  // injected scripts from running. We remove them before anything else.
  // The regex matches any <meta> tag with http-equiv="Content-Security-Policy"
  // regardless of attribute order or spacing.
  html = html.replace(
    /<meta[^>]+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*\/?>/gi,
    ""
  );

  // TRANSFORM 2: Inject <base> tag for URL resolution
  // This is the most important transformation. By injecting:
  //   <base href="https://html.duckduckgo.com/">
  // we instruct the browser to resolve ALL relative URLs against DDG's domain.
  // This fixes:
  //   - CSS files: /css/home2.css → https://html.duckduckgo.com/css/home2.css
  //   - Images:    /assets/logo.png → https://html.duckduckgo.com/assets/logo.png
  //   - Scripts:   /js/app.js → https://html.duckduckgo.com/js/app.js
  //
  // PLACEMENT: The <base> tag MUST come before any other resource references
  // in the <head>. Placing it immediately after <head> guarantees this.
  html = html.replace(
    /<head(\s[^>]*)?>/i,
    (match) => `${match}<base href="${BASE_DDG}/">`
  );

  // TRANSFORM 3: Inject our interception script
  // This script runs in the fetched page (inside the about:blank tab) and:
  //   a) Intercepts any search form submissions, redirecting them through
  //      our proxy instead of directly to DuckDuckGo
  //   b) Intercepts pagination links
  //   c) Adds a subtle "back to search" link so the user can return
  //
  // We inject it just before </body> so the DOM is fully parsed when it runs.
  const interceptScript = `
<script>
(function() {
  "use strict";

  // ── Form Interception ──────────────────────────────────────────────────────
  // DDG's HTML page has a search form. If the user types a new search or
  // clicks "next page" (which submits a form), we catch it and reroute it
  // through our proxy so it stays in this about:blank tab.
  document.addEventListener("DOMContentLoaded", function () {

    // Intercept all form submissions
    document.querySelectorAll("form").forEach(function (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var qInput = form.querySelector("input[name='q']");
        if (qInput && qInput.value.trim()) {
          window.location.href = "/api/proxy?q=" + encodeURIComponent(qInput.value.trim());
        }
      });
    });

    // Intercept DDG pagination links (they use ?s= and ?dc= parameters)
    // These links would otherwise point to duckduckgo.com directly,
    // bypassing our proxy and leaving a history entry.
    document.querySelectorAll("a[href]").forEach(function (link) {
      var href = link.getAttribute("href");
      // Only intercept internal DDG navigation, not result links
      if (href && (href.indexOf("duckduckgo.com/html") !== -1 || href.startsWith("/html"))) {
        link.addEventListener("click", function (e) {
          e.preventDefault();
          var resolvedHref = link.href; // Browser resolves relative → absolute via <base>
          window.location.href = "/api/proxy?url=" + encodeURIComponent(resolvedHref);
        });
      }
    });

    // ── "Return to Search" Banner ────────────────────────────────────────────
    // Injects a small unobtrusive banner at the top of the results page
    // so the user can easily navigate back to the private search UI.
    var banner = document.createElement("div");
    banner.innerHTML =
      "<span style='opacity:0.7'>🔒 Private Search Proxy</span>" +
      "<a href='javascript:window.close()' style='margin-left:16px;color:#93c5fd;text-decoration:none;'>✕ Close Tab</a>";
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:99999;" +
      "background:#0f0f0f;color:#e0e0e0;padding:6px 14px;" +
      "font-size:12px;font-family:monospace;display:flex;" +
      "align-items:center;box-shadow:0 1px 4px rgba(0,0,0,0.5);";
    document.body.insertBefore(banner, document.body.firstChild);

    // Push page content down so the banner doesn't overlap results
    document.body.style.paddingTop = "30px";
  });
})();
</script>
`;

  if (html.includes("</body>")) {
    html = html.replace("</body>", interceptScript + "\n</body>");
  } else {
    // Fallback: if </body> is missing, append to end
    html += interceptScript;
  }

  // ── Response Headers ───────────────────────────────────────────────────────
  // We deliberately set ONLY what we need. We do NOT forward any of DDG's
  // response headers because they contain restrictive CSP, X-Frame-Options,
  // and other security headers that would interfere with rendering.
  //
  // NOTE: X-Frame-Options is irrelevant here because we're using document.write()
  // into an about:blank window, not an iframe. It's set permissively anyway
  // as a safety measure in case of edge cases.
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");

  // Permissive CSP on our proxy response — allows DDG's assets to load freely
  res.setHeader(
    "Content-Security-Policy",
    "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;"
  );

  return res.status(200).send(html);
};
