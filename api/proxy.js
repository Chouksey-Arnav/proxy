// api/proxy.js — Vercel Serverless Function (Node.js 18, CommonJS)
// Fetches DuckDuckGo HTML results server-side, transforms them, and returns them.

module.exports = async function handler(req, res) {

  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const DDG = "https://html.duckduckgo.com";
  const { q, url } = req.query;

  // ── Build target URL ──────────────────────────────────────────────────────
  let targetUrl;

  if (q) {
    targetUrl = `${DDG}/html/?q=${encodeURIComponent(q)}&kl=us-en`;
  } else if (url) {
    let decoded;
    try {
      decoded = decodeURIComponent(url);
      const parsed = new URL(decoded);
      if (!parsed.hostname.endsWith("duckduckgo.com")) {
        return res.status(403).send("Only duckduckgo.com URLs are allowed.");
      }
      targetUrl = parsed.toString();
    } catch {
      return res.status(400).send("Invalid url parameter.");
    }
  } else {
    return res.status(400).send("Missing parameter: ?q= or ?url=");
  }

  // ── Fetch from DuckDuckGo ─────────────────────────────────────────────────
  // Use AbortController + setTimeout instead of AbortSignal.timeout()
  // because AbortSignal.timeout() has spotty support on some Vercel builds.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  let upstreamText;
  try {
    const upstream = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Referer": "https://duckduckgo.com/",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
    });

    if (!upstream.ok) {
      clearTimeout(timer);
      return res.status(502).send(`DuckDuckGo returned ${upstream.status}`);
    }

    upstreamText = await upstream.text();
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === "AbortError";
    return res.status(isTimeout ? 504 : 502).send(
      isTimeout ? "Request timed out fetching DuckDuckGo." : `Fetch error: ${err.message}`
    );
  } finally {
    clearTimeout(timer);
  }

  // ── Transform HTML ────────────────────────────────────────────────────────

  let html = upstreamText;

  // 1. Remove any CSP meta tags DDG embeds — they would block our injected script
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*\/?>/gi, "");

  // 2. Inject <base> tag so all relative URLs (CSS, images, scripts) resolve
  //    against html.duckduckgo.com automatically — no per-URL rewriting needed
  html = html.replace(/(<head\b[^>]*>)/i, `$1<base href="${DDG}/">`);

  // 3. Inject interception script so searches/pagination stay in proxy tab
  const script = `
<script>
(function () {
  document.addEventListener("DOMContentLoaded", function () {

    // Intercept the search form so re-searches go through our proxy
    document.querySelectorAll("form").forEach(function (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var input = form.querySelector("input[name='q']");
        if (input && input.value.trim()) {
          window.location.href = "/api/proxy?q=" + encodeURIComponent(input.value.trim());
        }
      });
    });

    // Intercept DDG internal navigation links (pagination, etc.)
    document.querySelectorAll("a[href]").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (href.indexOf("/html") === 0 || href.indexOf("duckduckgo.com/html") !== -1) {
        a.addEventListener("click", function (e) {
          e.preventDefault();
          window.location.href = "/api/proxy?url=" + encodeURIComponent(a.href);
        });
      }
    });

    // Thin banner so user can close the tab
    var bar = document.createElement("div");
    bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:999999;background:#0d1117;color:#8b949e;font:12px/30px monospace;padding:0 14px;display:flex;justify-content:space-between;border-bottom:1px solid #21262d;";
    bar.innerHTML = '<span>&#128274; Private Search Proxy</span><a href="javascript:window.close()" style="color:#58a6ff;text-decoration:none;">Close &#x2715;</a>';
    document.body.style.marginTop = "31px";
    document.body.insertBefore(bar, document.body.firstChild);
  });
})();
</script>`;

  if (html.includes("</body>")) {
    html = html.replace("</body>", script + "</body>");
  } else {
    html += script;
  }

  // ── Send response ─────────────────────────────────────────────────────────
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(html);
};
