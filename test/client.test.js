const { createClient } = require("../src/client.js");

let pass = 0, fail = 0;
const fails = [];

function eq(name, got, want) {
  if (got === want) { pass++; return; }
  fail++; fails.push({ name, got, want });
}
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; fails.push({ name, got: detail || "false", want: "true" });
}
async function rejects(name, fn, needle) {
  try {
    await fn();
    fail++; fails.push({ name, got: "resolved", want: "error containing " + needle });
  } catch (e) {
    if (String(e.message).includes(needle)) { pass++; return e; }
    fail++; fails.push({ name, got: e.message, want: "error containing " + needle });
  }
}

/* A session shaped like the one config.js hands out, with no secrets. */
function session(mode) {
  const auth = {
    token: { mode: "token", header: "Bearer t", describe: "personal access token" },
    anonymous: { mode: "anonymous", header: null, describe: "anonymous access" },
  }[mode || "token"];
  return {
    baseUrl: "https://wiki.example.com",
    auth: auth,
    headers: function (extra) {
      const h = Object.assign({ Accept: "application/json" }, extra || {});
      if (auth.header) h.Authorization = auth.header;
      return h;
    },
  };
}

/* A fetch that replays canned responses and records every call. */
function fakeFetch(responses) {
  const calls = [];
  const queue = responses.slice();
  const fn = function (url, init) {
    calls.push({ url: url, method: init.method, headers: init.headers, body: init.body });
    const next = queue.shift();
    if (!next) throw new Error("fake fetch: no response queued for " + init.method + " " + url);
    if (next.networkError) return Promise.reject(new Error(next.networkError));
    return Promise.resolve({
      status: next.status || 200,
      statusText: next.statusText || "OK",
      ok: (next.status || 200) < 400,
      text: function () {
        return Promise.resolve(
          typeof next.body === "string" ? next.body : JSON.stringify(next.body)
        );
      },
    });
  };
  fn.calls = calls;
  return fn;
}

const STORAGE =
  "<h1>Onboarding</h1>" +
  '<ac:structured-macro ac:name="warning" ac:schema-version="1" ac:macro-id="w1">' +
  "<ac:rich-text-body><p>Careful.</p></ac:rich-text-body></ac:structured-macro>" +
  "<p>Plain text.</p>";

const PAGE = {
  id: "100000001",
  title: "Onboarding",
  space: { key: "DEMO" },
  version: { number: 12, by: { displayName: "John Doe" }, when: "2026-09-20T09:00:00Z" },
  body: { storage: { value: STORAGE } },
};

function meta(version, macros) {
  return { pageId: "100000001", version: version, macros: macros };
}

(async function () {
  /* ---------------- 1. page references ---------------- */
  {
    const c = createClient(session(), { fetch: fakeFetch([]) });
    eq("bare id", c.pageIdFrom("100000001"), "100000001");
    eq("viewpage url", c.pageIdFrom("https://wiki.example.com/pages/viewpage.action?pageId=42"), "42");
    eq("pretty url", c.pageIdFrom("https://wiki.example.com/pages/77/Onboarding"), "77");
    await rejects("garbage is refused", async function () { c.pageIdFrom("not a page"); },
      "Expected a page id");
  }

  /* ---------------- 2. pull ---------------- */
  {
    const f = fakeFetch([{ body: PAGE }]);
    const c = createClient(session(), { fetch: f });
    const r = await c.pull("100000001");

    eq("pull: title", r.title, "Onboarding");
    eq("pull: version", r.version, 12);
    eq("pull: space", r.spaceKey, "DEMO");
    eq("pull: one opaque block", r.macros.length, 1);
    ok("pull: markdown has the heading", r.markdown.includes("# Onboarding"), r.markdown);
    ok("pull: no raw markup left", !/<ac:|<ri:/.test(r.markdown), r.markdown);
    ok("pull: url points at the page", r.url.endsWith("pageId=100000001"), r.url);

    eq("pull: one request", f.calls.length, 1);
    eq("pull: method", f.calls[0].method, "GET");
    ok("pull: expands what it needs", f.calls[0].url.includes("expand=body.storage,version,space"),
       f.calls[0].url);
    eq("pull: sends the credential", f.calls[0].headers.Authorization, "Bearer t");
  }

  /* ---------------- 3. a page with no storage body ---------------- */
  {
    const c = createClient(session(), { fetch: fakeFetch([{ body: { id: "1", title: "x" } }]) });
    await rejects("pull: empty body explained", function () { return c.pull("1"); },
      "no body.storage.value");
  }

  /* ---------------- 4. push refuses to drop opaque blocks ---------------- */
  {
    const f = fakeFetch([{ body: PAGE }]);
    const c = createClient(session(), { fetch: f });
    const pulled = await c.pull("100000001");
    const withoutMacro = pulled.markdown.replace(pulled.macros[0].token, "");

    const e = await rejects("push: refuses a dropped block",
      function () { return c.push("100000001", meta(12, pulled.macros), withoutMacro); },
      "Refusing to publish");
    eq("push: reports the reason as a code", e.code, "MACROS_MISSING");
    eq("push: names the block", e.missing.length, 1);
    eq("push: nothing was written", f.calls.length, 1);
  }

  /* ---------------- 5. push refuses a page that moved on ---------------- */
  {
    const live = { title: "Onboarding", space: { key: "DEMO" },
      version: { number: 14, by: { displayName: "John Doe" }, when: "2026-09-20T09:14:00Z" } };
    const f = fakeFetch([{ body: live }]);
    const c = createClient(session(), { fetch: f });

    const e = await rejects("push: refuses a stale copy",
      function () { return c.push("100000001", meta(12, []), "# Onboarding\n\nedited"); },
      "the page changed after you pulled it");
    eq("push: stale is coded", e.code, "STALE");
    ok("push: names the other editor", e.message.includes("John Doe"), e.message);
    ok("push: names both versions", e.message.includes("v12") && e.message.includes("v14"), e.message);
    eq("push: no PUT was sent", f.calls.filter(function (x) { return x.method === "PUT"; }).length, 0);
  }

  /* ---------------- 6. force publishes over a stale copy ---------------- */
  {
    const live = { title: "Onboarding", space: { key: "DEMO" },
      version: { number: 14, by: { displayName: "John Doe" }, when: "2026-09-20T09:14:00Z" } };
    const f = fakeFetch([{ body: live }, { body: {} }]);
    const c = createClient(session(), { fetch: f });

    const r = await c.push("100000001", meta(12, []), "# Onboarding\n\nedited", { force: true });
    eq("force: published", r.toVersion, 15);
    eq("force: says it overwrote", r.forcedOverStale, true);
  }

  /* ---------------- 7. a clean push ---------------- */
  {
    const live = { title: "Onboarding", space: { key: "DEMO" },
      version: { number: 12, by: { displayName: "John Doe" }, when: "2026-09-20T09:00:00Z" } };
    const f = fakeFetch([{ body: PAGE }, { body: live }, { body: {} }]);
    const c = createClient(session(), { fetch: f });

    const pulled = await c.pull("100000001");
    const edited = pulled.markdown + "\n\n## New section\n\nadded by hand\n";
    const r = await c.push("100000001", meta(12, pulled.macros), edited, { message: "typo" });

    eq("push: from version", r.fromVersion, 12);
    eq("push: to version", r.toVersion, 13);
    eq("push: nothing removed", r.removedMacros, 0);

    const put = f.calls.find(function (x) { return x.method === "PUT"; });
    const body = JSON.parse(put.body);
    eq("put: version number", body.version.number, 13);
    eq("put: version message", body.version.message, "typo");
    eq("put: representation", body.body.storage.representation, "storage");
    eq("put: space preserved", body.space.key, "DEMO");
    ok("put: opaque block returned verbatim",
       body.body.storage.value.includes(pulled.macros[0].xml), body.body.storage.value.slice(0, 200));
    ok("put: the edit landed", body.body.storage.value.includes("New section"),
       body.body.storage.value.slice(0, 200));
    eq("put: XSRF header present", put.headers["X-Atlassian-Token"], "no-check");
    eq("put: content type", put.headers["Content-Type"], "application/json");
  }

  /* ---------------- 8. an empty edit is refused before any request ---------------- */
  {
    const f = fakeFetch([]);
    const c = createClient(session(), { fetch: f });
    await rejects("push: empty markdown", function () { return c.push("1", meta(1, []), "   "); },
      "the Markdown is empty");
    eq("push: no request made", f.calls.length, 0);
  }

  /* ---------------- 9. status reports without changing anything ---------------- */
  {
    const live = { title: "Onboarding", space: { key: "DEMO" },
      version: { number: 14, by: { displayName: "John Doe" }, when: "2026-09-20T09:14:00Z" } };
    const f = fakeFetch([{ body: live }]);
    const c = createClient(session(), { fetch: f });

    const s = await c.status("100000001", meta(12, []), "# Onboarding");
    eq("status: local version", s.localVersion, 12);
    eq("status: live version", s.liveVersion, 14);
    eq("status: behind", s.behind, true);
    eq("status: names the editor", s.lastEditedBy, "John Doe");
    eq("status: read only", f.calls.filter(function (x) { return x.method !== "GET"; }).length, 0);
  }

  /* ---------------- 10. HTTP failures say what to do ---------------- */
  {
    const c = createClient(session(), { fetch: fakeFetch([{ status: 401, body: "" }]) });
    await rejects("401 names the credential kind", function () { return c.pull("1"); },
      "rejected the personal access token");

    const anon = createClient(session("anonymous"), { fetch: fakeFetch([{ status: 401, body: "" }]) });
    await rejects("401 anonymous explains itself", function () { return anon.pull("1"); },
      "does not serve pages anonymously");

    const c403 = createClient(session(), { fetch: fakeFetch([{ status: 403, body: "" }]) });
    await rejects("403", function () { return c403.pull("1"); }, "access denied");

    const c404 = createClient(session(), { fetch: fakeFetch([{ status: 404, body: "" }]) });
    await rejects("404", function () { return c404.pull("1"); }, "no page with this id");

    const html = createClient(session(), { fetch: fakeFetch([{ body: "<html>login</html>" }]) });
    await rejects("HTML instead of JSON", function () { return html.pull("1"); },
      "HTML instead of JSON");

    const down = createClient(session(), { fetch: fakeFetch([{ networkError: "ECONNREFUSED" }]) });
    await rejects("network failure names the host", function () { return down.pull("1"); },
      "wiki.example.com");
  }

  /* ---------------- report ---------------- */
  console.log("");
  if (fails.length) {
    console.log("FAILURES (" + fails.length + "):\n");
    fails.forEach(function (f) {
      console.log("  ✗ " + f.name);
      console.log("      got:  " + JSON.stringify(f.got).slice(0, 300));
      console.log("      want: " + JSON.stringify(f.want).slice(0, 300));
    });
    console.log("");
  }
  console.log("passed " + pass + ", failed " + fail);
  process.exit(fail ? 1 : 0);
})();
