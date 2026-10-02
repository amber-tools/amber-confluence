/* The doctor against instances in every state it is meant to recognise.
 * Two promises are checked above all: it never writes, and --share never
 * leaks the host, the account or the page. */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { createFakeConfluence } = require("./fixtures/fake-confluence.js");
const cfg = require("../src/config.js");
const { runDoctor, render, exitCode } = require("../src/doctor.js");

let pass = 0, fail = 0, skipped = 0;
const fails = [];

function eq(name, got, want) {
  if (got === want) { pass++; return; }
  fail++; fails.push({ name, got, want });
}
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; fails.push({ name, got: detail || "false", want: "true" });
}

const PAGE =
  "<h1>Quarterly Secret Plan</h1>" +
  '<ac:structured-macro ac:name="info" ac:macro-id="a1"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>' +
  '<p>Status: <ac:structured-macro ac:name="status" ac:macro-id="s1"><ac:parameter ac:name="title">OK</ac:parameter></ac:structured-macro></p>';

function loaderFor(url, env, cf) {
  return function () {
    return cfg.load({
      parsed: { confluence: Object.assign({ url: url }, cf || {}) },
      env: Object.assign({}, env || { AMBER_CONFLUENCE_TOKEN: "test-token" }),
      file: "/nowhere/config.toml",
      keychain: function () { return null; },
    });
  };
}

function statusOf(report, id) {
  const c = report.checks.find(function (x) { return x.id === id; });
  return c ? c.status : "absent";
}

async function doctorAgainst(fakeOptions, extra) {
  const e = extra || {};
  const fake = await createFakeConfluence(fakeOptions);
  fake.addPage("100000001", { title: "Quarterly Secret Plan", storage: PAGE, version: 7 });
  try {
    const report = await runDoctor({
      loadSession: loaderFor(fake.url, e.env, e.cf),
      pageRef: e.page === undefined ? "100000001" : e.page,
    });
    return { report: report, fake: fake };
  } finally {
    await fake.close();
  }
}

(async function () {
  /* ---------------- 1. a healthy instance ---------------- */
  {
    const { report, fake } = await doctorAgainst({ version: "8.5.4" });
    eq("healthy: reach", statusOf(report, "reach"), "ok");
    eq("healthy: sign-in", statusOf(report, "signin"), "ok");
    eq("healthy: page round trip", statusOf(report, "page"), "ok");
    eq("healthy: version recorded", report.facts.confluence, "8.5.4");
    eq("healthy: both blocks counted", report.facts.page.opaqueBlocks, 2);
    eq("healthy: exit code 0", exitCode(report), 0);
    ok("healthy: nothing was written",
       fake.requests.every(function (r) { return r.method === "GET"; }),
       fake.requests.map(function (r) { return r.method; }).join(","));
    eq("healthy: page left at its version", fake.pages["100000001"].version.number, 7);

    const shared = render(report, true);
    ok("share: no host", shared.indexOf("localhost") === -1 && shared.indexOf("127.0.0.1") === -1, shared);
    ok("share: no account name", shared.indexOf("John Doe") === -1, shared);
    ok("share: no page title", shared.indexOf("Quarterly") === -1, shared);
    ok("share: keeps the useful facts", shared.indexOf("8.5.4") !== -1 && shared.indexOf("status") !== -1, shared);

    const local = render(report, false);
    ok("local report names the account", local.indexOf("John Doe") !== -1, local);
  }

  /* ---------------- 2. a token on a version that has none ---------------- */
  {
    const { report } = await doctorAgainst({ version: "7.4.18" });
    eq("7.4 with a token: flagged", statusOf(report, "auth-fit"), "fail");
    ok("7.4 with a token: says what to do instead",
       report.checks.find(function (c) { return c.id === "auth-fit"; }).detail.indexOf("password") !== -1);
  }

  /* ---------------- 3. a password where a token would do ---------------- */
  {
    const { report } = await doctorAgainst({ version: "9.2.1" }, {
      env: { AMBER_CONFLUENCE_PASSWORD: "pw" }, cf: { user: "john.doe@example.com" },
    });
    eq("password on 9.2: a suggestion, not a failure", statusOf(report, "auth-fit"), "warn");
    eq("password on 9.2: still works", statusOf(report, "signin"), "ok");
  }

  /* ---------------- 4. single sign-on in front ---------------- */
  {
    const { report } = await doctorAgainst({ quirk: "sso" });
    eq("sso: reach is a warning", statusOf(report, "reach"), "warn");
    eq("sso: sign-in fails", statusOf(report, "signin"), "fail");
  }

  /* ---------------- 5. CAPTCHA lock ---------------- */
  {
    const { report } = await doctorAgainst({ quirk: "captcha" });
    const signin = report.checks.find(function (c) { return c.id === "signin"; });
    eq("captcha: sign-in fails", signin && signin.status, "fail");
    ok("captcha: named", signin && signin.summary.indexOf("CAPTCHA") !== -1, signin && signin.summary);
  }

  /* ---------------- 6. no page given, and a page that does not exist ---------------- */
  {
    const none = await doctorAgainst({}, { page: null });
    eq("no page: skipped, not failed", statusOf(none.report, "page"), "skip");
    eq("no page: exit code 0", exitCode(none.report), 0);

    const missing = await doctorAgainst({}, { page: "100000099" });
    eq("missing page: fails", statusOf(missing.report, "page"), "fail");
  }

  /* ---------------- 7. broken configuration ---------------- */
  {
    const report = await runDoctor({
      loadSession: function () { throw new Error("No Confluence URL configured.\nCreate it."); },
    });
    eq("broken config: reported", statusOf(report, "config"), "fail");
    eq("broken config: stops there", report.checks.length, 2);
    eq("broken config: exit code 1", exitCode(report), 1);
  }

  /* ---------------- 8. an untrusted certificate ---------------- */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-doctor-"));
    let tls = null;
    try {
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
        "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
      ], { stdio: "ignore" });
      tls = { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) };
    } catch (e) { skipped++; console.log("  - skipped: certificate case (openssl not available)"); }

    if (tls) {
      const { report } = await doctorAgainst({ tls: tls });
      eq("untrusted certificate: reach fails", statusOf(report, "reach"), "fail");
      const reach = report.checks.find(function (c) { return c.id === "reach"; });
      ok("untrusted certificate: points to ca_file", reach.detail.indexOf("ca_file") !== -1, reach.detail);
      const shared = render(report, true);
      ok("untrusted certificate: shared report hides the host", shared.indexOf("localhost") === -1, shared);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ---------------- report ---------------- */
  console.log("");
  if (fails.length) {
    console.log("FAILURES (" + fails.length + "):\n");
    fails.forEach(function (f) {
      console.log("  ✗ " + f.name);
      console.log("      got:  " + JSON.stringify(f.got).slice(0, 400));
      console.log("      want: " + JSON.stringify(f.want).slice(0, 400));
    });
    console.log("");
  }
  console.log("passed " + pass + ", failed " + fail + (skipped ? ", skipped " + skipped : ""));
  process.exit(fail ? 1 : 0);
})();
