const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore, parseHeader, digestOf } = require("../src/store.js");

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-store-"));
const store = createStore(dir);

const PAGE = {
  pageId: "100000001",
  title: "Onboarding",
  spaceKey: "DEMO",
  version: 12,
  markdown: "# Onboarding\n\n⟦macro.warning#1⟧\n\nPlain text.\n",
  macros: [{ token: "⟦macro.warning#1⟧", label: "macro.warning", xml: "<ac:structured-macro/>" }],
};

/* ---------------- 1. save and load ---------------- */
{
  const saved = store.save(PAGE);
  ok("markdown file written", fs.existsSync(saved.markdownFile), saved.markdownFile);
  ok("sidecar written", fs.existsSync(saved.sidecarFile), saved.sidecarFile);

  const back = store.load("100000001");
  eq("page id", back.meta.pageId, "100000001");
  eq("title", back.meta.title, "Onboarding");
  eq("space", back.meta.spaceKey, "DEMO");
  eq("version is a number", back.meta.version, 12);
  eq("markdown identical", back.markdown, PAGE.markdown);
  eq("macros restored", back.meta.macros.length, 1);
  eq("macro markup restored", back.meta.macros[0].xml, "<ac:structured-macro/>");
}

/* ---------------- 2. the file stays readable Markdown ---------------- */
{
  const text = fs.readFileSync(path.join(dir, "100000001.md"), "utf8");
  ok("starts with a header fence", text.startsWith("---\n"), text.slice(0, 20));
  ok("header names the page", text.includes("page_id: 100000001"), text.slice(0, 200));
  ok("heading survives", text.includes("# Onboarding"), text.slice(0, 300));
  ok("no raw macro markup in the file", !text.includes("<ac:structured-macro/>"), "sidecar should hold it");
}

/* ---------------- 3. a file without a header is refused clearly ---------------- */
{
  fs.writeFileSync(path.join(dir, "222.md"), "# Just Markdown\n", "utf8");
  throws("missing header explained", function () { store.load("222"); }, "has no amber header");
}

/* ---------------- 4. a page that was never pulled ---------------- */
{
  eq("unknown page returns null", store.load("999999"), null);
}

/* ---------------- 5. listing ---------------- */
{
  const ids = store.list();
  ok("lists the saved page", ids.indexOf("100000001") !== -1, ids.join(","));
  ok("ignores the sidecar", ids.every(function (i) { return /^\d+$/.test(i); }), ids.join(","));
}

/* ---------------- 6. header parsing on its own ---------------- */
{
  const parsed = parseHeader(
    "---\namber: confluence\npage_id: 7\ntitle: A page\nspace: X\nversion: 3\n" +
    "pulled_at: 2026-09-20T10:00:00Z\ndigest: sha256:abc\n---\n\nbody text\n"
  );
  eq("parsed id", parsed.meta.pageId, "7");
  eq("parsed version", parsed.meta.version, 3);
  eq("body without the header", parsed.markdown, "body text\n");

  const foreign = parseHeader("---\ntitle: someone else's front matter\n---\n\nbody\n");
  eq("foreign front matter is left alone", foreign.meta, null);
}

/* ---------------- 7. digests ---------------- */
{
  eq("stable", digestOf("abc"), digestOf("abc"));
  ok("differs on change", digestOf("abc") !== digestOf("abd"));
  ok("prefixed", digestOf("abc").startsWith("sha256:"), digestOf("abc"));
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
console.log("passed " + pass + ", failed " + fail);
process.exit(fail ? 1 : 0);
