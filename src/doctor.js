/* amber confluence doctor
 *
 * One command a stranger can run against an instance we have never seen,
 * which says what works, what does not and what to change — and, with
 * --share, prints a report safe to paste into a public issue: versions,
 * codes and timings, but no host, no account name, no page content.
 *
 * It never writes. The page check converts a page there and back in
 * memory and compares; nothing is sent to the server but reads.
 */

"use strict";

const C = require("./converter.js");
const { applyTrust } = require("./trust.js");
const { createClient } = require("./client.js");

const OK = "ok", WARN = "warn", FAIL = "fail", SKIP = "skip";

function majorOf(version) {
  const m = String(version || "").match(/^v?(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2] } : null;
}

function atLeast(v, major, minor) {
  return v && (v.major > major || (v.major === major && v.minor >= minor));
}

function firstLine(message) {
  return String(message || "").split("\n")[0];
}

/* Options are injected so the tests can run this against the fake instance
 * without touching the real configuration or the network. */
async function runDoctor(options) {
  const o = options || {};
  const checks = [];
  const facts = {};

  function add(id, status, summary, detail, shareable) {
    checks.push({ id: id, status: status, summary: summary, detail: detail || null, share: shareable || summary });
  }

  /* ---- Node ---- */
  const nodeVersion = majorOf(o.nodeVersion || process.version);
  facts.node = (o.nodeVersion || process.version);
  if (!nodeVersion || nodeVersion.major < 18) {
    add("node", FAIL, "Node " + facts.node + " is too old", "Install Node 18 or newer.");
  } else {
    add("node", OK, "Node " + facts.node);
  }

  /* ---- configuration ---- */
  let session;
  try {
    session = o.loadSession();
  } catch (e) {
    add("config", FAIL, "Configuration: " + firstLine(e.message), e.message, "Configuration could not be read");
    return { checks: checks, facts: facts };
  }
  facts.auth = session.auth.mode;
  add("config", OK,
    "Configuration read, signing in with " + session.auth.describe,
    "Config file: " + session.configFile,
    "Configuration read, auth: " + session.auth.mode);

  /* ---- certificates ---- */
  try {
    const trust = (o.applyTrust || applyTrust)({ caFile: session.caFile });
    facts.systemTrust = trust.system;
    facts.extraCertificates = trust.extraCount;
    if (!trust.supported) {
      add("trust", WARN,
        "This Node cannot add certificate authorities at runtime",
        "If your company signs its own certificates, start the tool with NODE_EXTRA_CA_CERTS=/path/to/ca.pem, or upgrade Node to 22.15 or newer.");
    } else {
      add("trust", OK,
        "Trusting " + (trust.system ? "the system store" : "Node's own list") +
        (trust.extraCount ? " and " + trust.extraCount + " certificate(s) from ca_file" : ""));
    }
  } catch (e) {
    add("trust", FAIL, firstLine(e.message), e.message);
    return { checks: checks, facts: facts };
  }

  const client = (o.createClient || createClient)(session, o.clientOptions);

  /* ---- reaching the instance, and which version it is ---- */
  let started = Date.now();
  let version = null;
  try {
    const answer = await client.request("GET", "/rest/applinks/1.0/manifest");
    facts.reachMs = Date.now() - started;
    const m = answer.text.match(/<version>([^<]+)<\/version>/);
    if (m) {
      version = m[1].trim();
      facts.confluence = version;
      add("reach", OK,
        "Reached Confluence " + version + " in " + facts.reachMs + " ms",
        "Instance: " + session.baseUrl,
        "Reached Confluence " + version + " in " + facts.reachMs + " ms");
    } else if (/<html/i.test(answer.text)) {
      add("reach", WARN,
        "Reached the host, but it answered with a web page instead of Confluence",
        "This usually means single sign-on sits in front, or the url points at the wrong path.");
    } else {
      add("reach", WARN, "Reached the host, but could not tell the Confluence version (status " + answer.res.status + ")");
    }
  } catch (e) {
    add("reach", FAIL, firstLine(e.message), e.message, "Could not reach the instance: " + firstLine(e.message).replace(session.baseUrl, "<instance>"));
    return { checks: checks, facts: facts };
  }

  /* ---- credential against version ---- */
  const v = majorOf(version);
  if (v && session.auth.mode === "token" && !atLeast(v, 7, 9)) {
    add("auth-fit", FAIL,
      "Confluence " + version + " has no personal access tokens",
      "Tokens exist from Data Center 7.9. Store your password instead, under the amber-confluence keychain service.");
  } else if (v && session.auth.mode === "basic" && atLeast(v, 7, 9)) {
    add("auth-fit", WARN,
      "Signing in with a password where a personal access token would work",
      "Tokens survive password changes and single sign-on. Create one in your Confluence profile.");
  }

  /* ---- signing in ---- */
  try {
    const answer = await client.request("GET", "/rest/api/user/current");
    const status = answer.res.status;
    let who = null;
    try { who = JSON.parse(answer.text); } catch (e) { who = null; }

    if (status === 200 && who && who.type !== "anonymous") {
      add("signin", OK,
        "Signed in" + (who.displayName ? " as " + who.displayName : ""),
        null,
        "Signed in");
    } else if (status === 200 && who && who.type === "anonymous") {
      add("signin", session.auth.mode === "anonymous" ? OK : FAIL,
        session.auth.mode === "anonymous"
          ? "Reading anonymously"
          : "The credential was not accepted; the instance treats you as anonymous");
    } else if (status === 401) {
      const denied = answer.res.headers && answer.res.headers.get ? answer.res.headers.get("x-authentication-denied-reason") : null;
      add("signin", FAIL,
        denied && /CAPTCHA/i.test(denied)
          ? "Account locked behind a CAPTCHA — sign in once in the browser"
          : "401: the " + session.auth.describe + " was rejected");
    } else if (status === 200 && who === null) {
      add("signin", FAIL, "A login page answered instead of Confluence",
        "Single sign-on is in front of the instance. A personal access token usually goes around it.");
    } else {
      add("signin", WARN, "Unexpected answer while checking the sign-in: " + status);
    }
  } catch (e) {
    add("signin", FAIL, firstLine(e.message), e.message);
  }

  /* ---- one page, there and back, in memory only ---- */
  if (!o.pageRef) {
    add("page", SKIP, "No page given — run `amber confluence doctor <page>` to test a conversion");
  } else {
    try {
      const page = await client.pull(o.pageRef);
      const back = C.toStorage(page.markdown, page.macros, page.layout);
      const intact = page.macros.filter(function (m) { return back.indexOf(m.xml) !== -1; }).length;
      const identical = typeof page.source === "string" && back === page.source;
      const kinds = Array.from(new Set(page.macros.map(function (m) { return m.label; }))).sort();

      facts.page = {
        opaqueBlocks: page.macros.length,
        intact: intact,
        identical: identical,
        kinds: kinds,
      };

      if (intact === page.macros.length && identical) {
        add("page", OK,
          "Page converts there and back byte for byte (" + page.macros.length + " opaque block(s))",
          kinds.length ? "Kinds: " + kinds.join(", ") : null,
          "Page round trip: byte for byte, " + page.macros.length + " block(s)" + (kinds.length ? " (" + kinds.join(", ") + ")" : ""));
      } else if (intact === page.macros.length) {
        add("page", WARN,
          "Page converts there and back with every opaque block intact, but not byte for byte",
          "Publishing an edit may reformat parts of the page you did not touch. Please report it with --share.",
          "Page round trip: blocks intact, page not byte for byte" + (kinds.length ? " (" + kinds.join(", ") + ")" : ""));
      } else {
        add("page", FAIL,
          "Page conversion lost " + (page.macros.length - intact) + " of " + page.macros.length + " opaque block(s)",
          "Please report this with `amber confluence doctor --share " + o.pageRef + "`.",
          "Page round trip lost " + (page.macros.length - intact) + " of " + page.macros.length + " block(s)" +
          (kinds.length ? " (" + kinds.join(", ") + ")" : ""));
      }
    } catch (e) {
      add("page", FAIL, firstLine(e.message), e.message, "Page could not be read: " + firstLine(e.message));
    }
  }

  return { checks: checks, facts: facts };
}

const MARK = { ok: "✓", warn: "!", fail: "✗", skip: "-" };

function render(report, share) {
  const lines = [];
  lines.push(share ? "amber confluence doctor (shareable: no host, no account, no content)" : "amber confluence doctor");
  lines.push("");
  report.checks.forEach(function (c) {
    lines.push("  " + MARK[c.status] + " " + (share ? c.share : c.summary));
    if (!share && c.detail && c.status !== OK) {
      const detail = c.detail.split("\n");
      /* Errors often repeat their first line as the summary; print it once. */
      if (detail.length && c.summary.indexOf(detail[0]) !== -1) detail.shift();
      while (detail.length && !detail[0].trim()) detail.shift();
      detail.forEach(function (d) { lines.push("      " + d); });
    }
  });

  const failed = report.checks.filter(function (c) { return c.status === FAIL; }).length;
  const warned = report.checks.filter(function (c) { return c.status === WARN; }).length;
  lines.push("");
  lines.push(failed
    ? failed + " problem(s) to fix" + (warned ? ", " + warned + " worth a look" : "") + "."
    : warned ? "Works. " + warned + " thing(s) worth a look." : "All good.");
  if (share) {
    lines.push("");
    lines.push("node " + report.facts.node +
      (report.facts.confluence ? " · confluence " + report.facts.confluence : "") +
      (report.facts.auth ? " · auth " + report.facts.auth : ""));
  }
  return lines.join("\n");
}

function exitCode(report) {
  return report.checks.some(function (c) { return c.status === FAIL; }) ? 1 : 0;
}

module.exports = { runDoctor, render, exitCode };
