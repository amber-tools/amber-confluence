/* Installations that misbehave in the ways real ones do.
 *
 * Every case here was first observed failing against the unmodified
 * client, then fixed. They run against test/fixtures/fake-confluence.js
 * over real sockets with the real fetch, so what is tested is what ships.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { createFakeConfluence } = require("./fixtures/fake-confluence.js");
const cfg = require("../src/config.js");
const { createClient } = require("../src/client.js");
const { applyTrust } = require("../src/trust.js");

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
function skip(name, why) {
  skipped++;
  console.log("  - skipped: " + name + " (" + why + ")");
}

const PAGE =
  "<h1>Onboarding</h1>" +
  '<ac:structured-macro ac:name="info" ac:schema-version="1" ac:macro-id="a1">' +
  "<ac:rich-text-body><p>keep me</p></ac:rich-text-body></ac:structured-macro>" +
  "<p>body text</p>";

function sessionFor(url, extra) {
  const e = extra || {};
  return cfg.load({
    parsed: { confluence: Object.assign({ url: url }, e.cf || {}) },
    env: Object.assign({ AMBER_CONFLUENCE_TOKEN: "test-token" }, e.env || {}),
    file: "/nowhere/config.toml",
    keychain: function () { return null; },
  });
}

/* Pull, edit, push. Returns the error message, or null on success. */
async function roundTrip(fake, client) {
  try {
    const p = await client.pull("100000001");
    await client.push("100000001", { version: p.version, macros: p.macros }, p.markdown + "\n\nedited");
    return null;
  } catch (e) {
    return e.message;
  }
}

async function withFake(options, body) {
  const fake = await createFakeConfluence(options);
  fake.addPage("100000001", { storage: PAGE, version: 3 });
  try { await body(fake); } finally { await fake.close(); }
}

(async function () {
  /* ---------------- 1. a plain instance ---------------- */
  await withFake({}, async function (fake) {
    const err = await roundTrip(fake, createClient(sessionFor(fake.url)));
    eq("plain: round trip succeeds", err, null);
    eq("plain: version advanced", fake.pages["100000001"].version.number, 4);
    ok("plain: macro kept byte for byte",
       fake.pages["100000001"].body.storage.value.indexOf(PAGE.slice(PAGE.indexOf("<ac:"), PAGE.indexOf("</ac:structured-macro>") + 22)) !== -1);
    ok("plain: token sent as bearer",
       fake.requests.every(function (r) { return r.headers.authorization === "Bearer test-token"; }));
  });

  /* ---------------- 2. behind a reverse proxy, under a path ---------------- */
  await withFake({ contextPath: "/confluence" }, async function (fake) {
    eq("context path: round trip succeeds", await roundTrip(fake, createClient(sessionFor(fake.url))), null);
    ok("context path: every request kept the prefix",
       fake.requests.every(function (r) { return r.path.indexOf("/confluence/rest/") === 0; }));
  });

  await withFake({ contextPath: "/confluence" }, async function (fake) {
    eq("context path with trailing slash in config",
       await roundTrip(fake, createClient(sessionFor(fake.url + "/"))), null);
  });

  /* ---------------- 3. compressed responses ---------------- */
  await withFake({ quirk: "gzip" }, async function (fake) {
    eq("gzip: round trip succeeds", await roundTrip(fake, createClient(sessionFor(fake.url))), null);
  });

  /* ---------------- 4. error messages in another language ---------------- */
  await withFake({ quirk: "german" }, async function (fake) {
    const client = createClient(sessionFor(fake.url));
    eq("localised instance: round trip succeeds", await roundTrip(fake, client), null);
    let msg = null;
    try { await client.pull("100000099"); } catch (e) { msg = e.message; }
    ok("localised 404 is explained from the status, not the wording",
       msg && msg.indexOf("no page with this id") !== -1, msg);
  });

  /* ---------------- 5. rate limiting ---------------- */
  await withFake({ quirk: "ratelimit", rateLimitCount: 2 }, async function (fake) {
    const waits = [];
    const client = createClient(sessionFor(fake.url), {
      sleep: function (ms) { waits.push(ms); return Promise.resolve(); },
    });
    eq("rate limit: waited it out and succeeded", await roundTrip(fake, client), null);
    eq("rate limit: waited twice", waits.length, 2);
    ok("rate limit: honoured Retry-After of one second",
       waits.every(function (w) { return w === 1000; }), waits.join(","));
  });

  await withFake({ quirk: "ratelimit", rateLimitCount: 99 }, async function (fake) {
    const waits = [];
    const client = createClient(sessionFor(fake.url), {
      sleep: function (ms) { waits.push(ms); return Promise.resolve(); },
    });
    const msg = await roundTrip(fake, client);
    ok("persistent rate limit: gives up", msg !== null);
    eq("persistent rate limit: after three retries", waits.length, 3);
    ok("persistent rate limit: says so in words", msg && msg.indexOf("slow down") !== -1, msg);
  });

  /* ---------------- 6. single sign-on in front ---------------- */
  await withFake({ quirk: "sso" }, async function (fake) {
    const msg = await roundTrip(fake, createClient(sessionFor(fake.url)));
    ok("sso: recognised as a login page", msg && msg.indexOf("login page") !== -1, msg);
    ok("sso: points to personal access tokens", msg && msg.indexOf("personal access token") !== -1, msg);
  });

  /* ---------------- 7. locked behind a CAPTCHA ---------------- */
  await withFake({ quirk: "captcha" }, async function (fake) {
    const msg = await roundTrip(fake, createClient(sessionFor(fake.url)));
    ok("captcha: named as such", msg && msg.indexOf("CAPTCHA") !== -1, msg);
    ok("captcha: does not blame the credential",
       msg && msg.indexOf("rejected") === -1, msg);
  });

  /* ---------------- 8. a server that never answers ---------------- */
  await withFake({ delayMs: 1600 }, async function (fake) {
    const started = Date.now();
    const msg = await roundTrip(fake, createClient(sessionFor(fake.url, { env: { AMBER_TIMEOUT: "1" } })));
    const took = Date.now() - started;
    ok("timeout: gives up", msg && msg.indexOf("No answer") !== -1, msg);
    ok("timeout: after the configured second, not later", took < 1500, took + " ms");
    ok("timeout: says how to raise it", msg && msg.indexOf("timeout = ") !== -1, msg);
  });

  /* ---------------- 9. certificates ----------------
   * Last, because trusting a certificate changes process-wide state. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-tls-"));
  let tls = null;
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    ], { stdio: "ignore" });
    tls = { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) };
  } catch (e) {
    skip("certificate cases", "openssl not available");
  }

  if (tls) {
    await withFake({ tls: tls }, async function (fake) {
      const msg = await roundTrip(fake, createClient(sessionFor(fake.url)));
      ok("self-signed: refused", msg !== null);
      ok("self-signed: explains the cause", msg && msg.indexOf("TLS check failed") !== -1, msg);
      ok("self-signed: shows the fix", msg && msg.indexOf("ca_file") !== -1, msg);
      ok("self-signed: never suggests switching checks off",
         msg && !/REJECT_UNAUTHORIZED\s*=\s*0|rejectUnauthorized:\s*false/.test(msg), msg);
    });

    const trust = applyTrust({ caFile: path.join(dir, "cert.pem") });
    if (!trust.supported) {
      skip("trusted certificate cases", "this Node cannot change trust at runtime");
    } else {
      eq("ca_file: certificate loaded", trust.extraCount, 1);

      await withFake({ tls: tls }, async function (fake) {
        eq("ca_file: round trip succeeds", await roundTrip(fake, createClient(sessionFor(fake.url))), null);
      });

      /* http:// in the config for an instance that only serves https://. */
      const target = await createFakeConfluence({ tls: tls });
      target.addPage("100000001", { storage: PAGE, version: 3 });
      await withFake({ quirk: "redirect", redirectTo: target.origin }, async function (fake) {
        const msg = await roundTrip(fake, createClient(sessionFor(fake.url)));
        ok("redirect: refused", msg !== null);
        ok("redirect: not blamed on the credential", msg && msg.indexOf("rejected") === -1, msg);
        ok("redirect: names the address to use", msg && msg.indexOf('url = "' + target.origin) !== -1, msg);
        eq("redirect: nothing was written", target.pages["100000001"].version.number, 3);
      });
      await target.close();
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });

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
  console.log("passed " + pass + ", failed " + fail + (skipped ? ", skipped " + skipped : ""));
  process.exit(fail ? 1 : 0);
})();
