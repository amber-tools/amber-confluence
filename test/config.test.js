const cfg = require("../src/config.js");

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
function throws(name, fn, needle) {
  try {
    fn();
    fail++; fails.push({ name, got: "no error", want: "error containing " + needle });
  } catch (e) {
    if (String(e.message).includes(needle)) { pass++; return; }
    fail++; fails.push({ name, got: e.message, want: "error containing " + needle });
  }
}

/* A config loaded from memory: no file system, no keychain, no env. */
function load(parsed, env, keychain) {
  return cfg.load({
    parsed: parsed,
    env: env || {},
    file: "/nowhere/config.toml",
    keychain: keychain || function () { return null; },
  });
}

const BASE = { confluence: { url: "https://wiki.example.com", user: "john.doe@example.com" } };

/* ---------------- 1. the TOML subset ---------------- */
{
  const t = cfg.parseToml(
    '# a comment\n' +
    '[confluence]\n' +
    'url = "https://wiki.example.com"   # trailing comment\n' +
    "user = 'john.doe@example.com'\n" +
    "timeout = 30\n" +
    "verify_tls = true\n",
    "test.toml"
  );
  eq("section parsed", typeof t.confluence, "object");
  eq("double-quoted string", t.confluence.url, "https://wiki.example.com");
  eq("single-quoted string", t.confluence.user, "john.doe@example.com");
  eq("integer", t.confluence.timeout, 30);
  eq("boolean", t.confluence.verify_tls, true);

  throws("unquoted value is refused", function () {
    cfg.parseToml("[confluence]\nurl = https://wiki.example.com\n", "test.toml");
  }, "must be quoted");

  throws("broken line names its line number", function () {
    cfg.parseToml("[confluence]\nthis is not a pair\n", "test.toml");
  }, "test.toml:2");
}

/* ---------------- 2. secrets are refused in the file ---------------- */
{
  throws("token in file is refused", function () {
    load({ confluence: { url: "https://wiki.example.com", token: "abc123" } });
  }, "Remove confluence.token");

  throws("password in file is refused", function () {
    load({ confluence: { url: "https://wiki.example.com", password: "hunter2" } });
  }, "Remove confluence.password");

  try {
    load({ confluence: { url: "https://wiki.example.com", token: "abc123" } });
  } catch (e) {
    ok("refusal does not echo the secret", !e.message.includes("abc123"), e.message);
    ok("refusal explains where secrets belong", e.message.includes("keychain"), e.message);
  }
}

/* ---------------- 3. a token wins and needs no username ---------------- */
{
  const s = load({ confluence: { url: "https://wiki.example.com" } }, { AMBER_CONFLUENCE_TOKEN: "s3cr3t-value" });
  eq("mode is token", s.auth.mode, "token");
  eq("bearer header", s.headers().Authorization, "Bearer s3cr3t-value");
  eq("describes itself without the secret", s.auth.describe, "personal access token");
  ok("describe never carries the secret", !s.auth.describe.includes("s3cr3t-value"));
}

/* ---------------- 4. username and password still work ---------------- */
{
  const s = load(BASE, { AMBER_CONFLUENCE_PASSWORD: "pw" });
  eq("mode is basic", s.auth.mode, "basic");
  eq("basic header", s.headers().Authorization,
     "Basic " + Buffer.from("john.doe@example.com:pw").toString("base64"));
}

/* ---------------- 5. the keychain is consulted, token before password ---------------- */
{
  const asked = [];
  const s = load(BASE, {}, function (service, account) {
    asked.push(service);
    return service.endsWith("-token") ? "keychain-token" : "keychain-password";
  });
  eq("token service asked first", asked[0], "amber-confluence-token");
  eq("token from keychain wins", s.auth.mode, "token");
  eq("bearer from keychain", s.headers().Authorization, "Bearer keychain-token");

  const basicOnly = load(BASE, {}, function (service) {
    return service.endsWith("-token") ? null : "keychain-password";
  });
  eq("falls back to password", basicOnly.auth.mode, "basic");
}

/* ---------------- 6. environment overrides the file ---------------- */
{
  const s = load(BASE, {
    AMBER_CONFLUENCE_URL: "https://other.example.com",
    AMBER_CONFLUENCE_TOKEN: "tok",
  });
  eq("env url wins", s.baseUrl, "https://other.example.com");
}

/* ---------------- 7. anonymous access is allowed ---------------- */
{
  const s = load({ confluence: { url: "https://wiki.example.com" } });
  eq("mode is anonymous", s.auth.mode, "anonymous");
  eq("no Authorization header", s.headers().Authorization, undefined);
}

/* ---------------- 8. a username with no credential explains both paths ---------------- */
{
  try {
    load(BASE);
    fail++; fails.push({ name: "missing credential throws", got: "no error", want: "error" });
  } catch (e) {
    ok("names the account", e.message.includes("john.doe@example.com"), e.message);
    ok("mentions personal access token", e.message.includes("personal access token"), e.message);
    ok("mentions older instances", e.message.includes("older instances"), e.message);
  }
}

/* ---------------- 9. url handling ---------------- */
{
  const s = load({ confluence: { url: "https://wiki.example.com/////" } }, { AMBER_CONFLUENCE_TOKEN: "t" });
  eq("trailing slashes trimmed", s.baseUrl, "https://wiki.example.com");

  throws("missing url is explained", function () { load({}); }, "No Confluence URL configured");
  throws("scheme is required", function () {
    load({ confluence: { url: "wiki.example.com" } });
  }, "must start with http");
}

/* ---------------- 10. headers merge, Accept always present ---------------- */
{
  const s = load({ confluence: { url: "https://wiki.example.com" } }, { AMBER_CONFLUENCE_TOKEN: "t" });
  const h = s.headers({ "Content-Type": "application/json" });
  eq("accept kept", h.Accept, "application/json");
  eq("extra kept", h["Content-Type"], "application/json");
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
