/* A stand-in for a Confluence instance, for the cases a real test instance
 * cannot easily reproduce: a context path behind a reverse proxy, single
 * sign-on in front, a CAPTCHA lock after failed logins, rate limiting,
 * compressed responses, a self-signed certificate, error messages in a
 * language other than English.
 *
 * It implements only the endpoints the tool uses, and only as much of them
 * as the tool relies on. Every request is recorded so tests can assert on
 * what was actually sent.
 */

"use strict";

const http = require("http");
const https = require("https");
const zlib = require("zlib");

function createFakeConfluence(options) {
  const o = Object.assign(
    {
      contextPath: "",
      tls: null,
      quirk: null,
      version: "8.5.0",
      requireAuth: true,
      rateLimitCount: 2,
      delayMs: 0,
      redirectTo: null,
    },
    options || {}
  );

  const pages = Object.create(null);
  const requests = [];
  let limited = 0;

  function addPage(id, page) {
    pages[id] = {
      id: String(id),
      type: "page",
      title: page.title || "Page " + id,
      space: { key: page.space || "DEMO" },
      version: {
        number: page.version || 1,
        by: { displayName: page.editor || "John Doe" },
        when: page.when || "2026-10-01T09:00:00.000Z",
      },
      body: { storage: { value: page.storage || "<p>empty</p>", representation: "storage" } },
    };
  }

  function send(res, status, body, headers) {
    /* Node's own server stalls for seconds when an idle keep-alive socket is
     * reused, which would make retry timings meaningless. Real instances do
     * not, so the fixture simply closes each connection. */
    const h = Object.assign({ Connection: "close" }, headers || {});
    let payload = typeof body === "string" ? body : JSON.stringify(body);
    if (!h["Content-Type"]) {
      h["Content-Type"] = typeof body === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8";
    }
    if (o.quirk === "gzip") {
      payload = zlib.gzipSync(Buffer.from(payload, "utf8"));
      h["Content-Encoding"] = "gzip";
    }
    res.writeHead(status, h);
    res.end(payload);
  }

  function handle(req, res, raw) {
    const url = new URL(req.url, "http://localhost");
    requests.push({
      method: req.method,
      path: url.pathname,
      query: url.search,
      headers: req.headers,
      body: raw,
    });

    if (o.quirk === "redirect") {
      res.writeHead(301, { Location: o.redirectTo + req.url, Connection: "close" });
      return res.end();
    }

    if (!url.pathname.startsWith(o.contextPath + "/")) {
      return send(res, 404, { message: "Not found outside the context path" });
    }
    const path = url.pathname.slice(o.contextPath.length);

    if (o.quirk === "sso") {
      return send(res, 200,
        "<!DOCTYPE html><html><head><title>Sign in</title></head>" +
        "<body><form action=\"/saml/login\">Single sign-on</form></body></html>");
    }

    if (o.quirk === "ratelimit" && limited < o.rateLimitCount) {
      limited++;
      return send(res, 429, { message: "Rate limit exceeded" }, { "Retry-After": "1" });
    }

    if (o.requireAuth && !req.headers.authorization) {
      return send(res, 401, { message: "Not authenticated" });
    }

    if (o.quirk === "captcha") {
      return send(res, 401, { message: "Authentication denied" }, {
        "X-Authentication-Denied-Reason":
          "CAPTCHA_CHALLENGE; login-url=" + o.contextPath + "/login.action",
      });
    }

    if (path === "/rest/applinks/1.0/manifest") {
      return send(res, 200,
        "<manifest><typeId>confluence</typeId><name>Fake</name>" +
        "<version>" + o.version + "</version></manifest>",
        { "Content-Type": "application/xml" });
    }

    if (path === "/rest/api/user/current") {
      return send(res, 200, { type: "known", username: "john.doe", displayName: "John Doe" });
    }

    const m = path.match(/^\/rest\/api\/content\/(\d+)$/);
    if (m) {
      const page = pages[m[1]];

      if (!page) {
        /* Real instances localise this message; the tool must not depend on
         * the wording, only on the status. */
        return send(res, 404, {
          statusCode: 404,
          message: o.quirk === "german" ? "Seite nicht gefunden" : "No content found with id",
        });
      }

      if (req.method === "GET") return send(res, 200, page);

      if (req.method === "PUT") {
        if (req.headers["x-atlassian-token"] !== "no-check") {
          return send(res, 403, { message: "XSRF check failed" });
        }
        let body;
        try { body = JSON.parse(raw); } catch (e) { return send(res, 400, { message: "Bad JSON" }); }

        const expected = page.version.number + 1;
        if (!body.version || body.version.number !== expected) {
          return send(res, 409, { message: "Version must be " + expected });
        }

        page.version = {
          number: expected,
          by: { displayName: "John Doe" },
          when: new Date().toISOString(),
          message: body.version.message,
        };
        page.body.storage.value = body.body.storage.value;
        page.title = body.title || page.title;
        return send(res, 200, page);
      }
    }

    return send(res, 404, { message: "Unknown endpoint " + path });
  }

  const listener = function (req, res) {
    const chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (o.delayMs) setTimeout(function () { handle(req, res, raw); }, o.delayMs);
      else handle(req, res, raw);
    });
  };

  const server = o.tls ? https.createServer(o.tls, listener) : http.createServer(listener);

  return new Promise(function (resolve) {
    server.listen(0, "127.0.0.1", function () {
      const port = server.address().port;
      const scheme = o.tls ? "https" : "http";
      /* "localhost" rather than the IP, so a certificate issued for
       * localhost matches the host the client connects to. */
      resolve({
        url: scheme + "://localhost:" + port + o.contextPath,
        origin: scheme + "://localhost:" + port,
        pages: pages,
        requests: requests,
        addPage: addPage,
        close: function () {
          return new Promise(function (r) {
            if (server.closeAllConnections) server.closeAllConnections();
            server.close(function () { r(); });
          });
        },
      });
    });
  });
}

module.exports = { createFakeConfluence };
