/* The shipped command, end to end: a real `amber` process, real files on
 * disk, real HTTP to a stand-in instance. Nothing is injected; this is what
 * a person runs. */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const { createFakeConfluence } = require("./fixtures/fake-confluence.js");

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

const AMBER = path.join(__dirname, "..", "bin", "amber.js");

const PAGE =
  "<h1>Onboarding</h1>\n" +
  "<p>First line<br />second line</p>\n" +
  '<p><span style="color: rgb(255,0,0);">Late</span> items stay red.</p>\n' +
  '<ac:structured-macro ac:name="warning" ac:schema-version="1" ac:macro-id="w1">' +
  "<ac:rich-text-body><p>Careful.</p></ac:rich-text-body></ac:structured-macro>\n" +
  "<table><tbody><tr><th>Step</th><th>Details</th></tr><tr><td>1</td>" +
  "<td><ul><li><p>one</p></li><li><p>two</p></li></ul></td></tr></tbody></table>\n" +
  "<p>Closing paragraph.</p>\n";

/* The CLI runs as its own process, so the in-process server keeps
 * answering while it waits. */
function amber(args, env) {
  return new Promise(function (resolve) {
    execFile(process.execPath, [AMBER].concat(args), { env: env, timeout: 20000 }, function (err, stdout, stderr) {
      resolve({ code: err ? (err.code || 1) : 0, out: String(stdout), err: String(stderr) });
    });
  });
}

(async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amber-e2e-"));
  const fake = await createFakeConfluence({ version: "8.5.4" });
  fake.addPage("100000001", { title: "Onboarding", storage: PAGE, version: 5 });

  fs.writeFileSync(path.join(dir, "config.toml"), '[confluence]\nurl = "' + fake.url + '"\n');
  const env = Object.assign({}, process.env, {
    AMBER_CONFIG: path.join(dir, "config.toml"),
    AMBER_CONFLUENCE_TOKEN: "e2e-token",
    AMBER_PAGES_DIR: path.join(dir, "pages"),
  });
  const file = path.join(dir, "pages", "100000001.md");

  try {
    /* ---------------- pull ---------------- */
    let r = await amber(["confluence", "pull", "100000001"], env);
    eq("pull: exit 0", r.code, 0);
    ok("pull: file written", fs.existsSync(file));
    const pulled = fs.readFileSync(file, "utf8");
    ok("pull: header names the page", pulled.indexOf("page_id: 100000001") !== -1, pulled.slice(0, 200));
    ok("pull: the complex table is a marker, not a placeholder",
       pulled.indexOf("⟦table#1⟧") !== -1 && pulled.indexOf("kept as-is") === -1, pulled);

    /* ---------------- push without an edit ---------------- */
    r = await amber(["confluence", "push", "100000001"], env);
    eq("unedited push: exit 0", r.code, 0);
    ok("unedited push: says there is nothing to publish", r.out.indexOf("Nothing to publish") !== -1, r.out);
    eq("unedited push: no new version", fake.pages["100000001"].version.number, 5);

    /* ---------------- an edit, diffed and published ---------------- */
    /* A new paragraph after a blank line, as a person types it; a single
     * newline would continue the previous paragraph in Markdown. */
    fs.writeFileSync(file, pulled.replace("Closing paragraph.", "Closing paragraph, now edited.") + "\n\nA paragraph added at the end.\n");

    r = await amber(["confluence", "diff", "100000001"], env);
    eq("diff: exit 0", r.code, 0);
    ok("diff: shows the edit", r.out.indexOf("+ Closing paragraph, now edited.") !== -1, r.out);
    ok("diff: shows the addition", r.out.indexOf("+ A paragraph added at the end.") !== -1, r.out);

    r = await amber(["confluence", "push", "100000001", "-m", "e2e edit"], env);
    eq("push: exit 0", r.code, 0);
    const stored = fake.pages["100000001"].body.storage.value;
    eq("push: version advanced", fake.pages["100000001"].version.number, 6);
    eq("push: version comment", fake.pages["100000001"].version.message, "e2e edit");
    ok("push: everything above the edit is the original source, byte for byte",
       stored.indexOf(PAGE.slice(0, PAGE.indexOf("<p>Closing paragraph.</p>"))) === 0, stored.slice(0, 300));
    ok("push: the edit landed", stored.indexOf("Closing paragraph, now edited.") !== -1, stored);
    ok("push: the addition landed", stored.indexOf("<p>A paragraph added at the end.</p>") !== -1, stored);
    ok("push: the table with a list survived", stored.indexOf("<li><p>two</p></li>") !== -1, stored);
    ok("push: the line break survived", stored.indexOf("First line<br />second line") !== -1, stored);
    ok("push: the colour survived", stored.indexOf('style="color: rgb(255,0,0);"') !== -1, stored);

    /* ---------------- the local copy follows the published page ---------------- */
    r = await amber(["confluence", "push", "100000001"], env);
    ok("after push: nothing left to publish", r.out.indexOf("Nothing to publish") !== -1, r.out + r.err);

    /* ---------------- a colleague edits in the browser meanwhile ---------------- */
    fake.pages["100000001"].version = { number: 7, by: { displayName: "Jane Roe" }, when: "2026-10-02T10:00:00.000Z" };
    fs.writeFileSync(file, fs.readFileSync(file, "utf8") + "\n\nMy late addition.\n");

    r = await amber(["confluence", "status", "100000001"], env);
    ok("status: names the colleague", r.out.indexOf("Jane Roe") !== -1, r.out);

    r = await amber(["confluence", "push", "100000001"], env);
    eq("stale push: exit 2", r.code, 2);
    ok("stale push: explains", r.err.indexOf("changed after you pulled") !== -1, r.err);
    eq("stale push: colleague's version untouched", fake.pages["100000001"].version.number, 7);

    /* ---------------- a marker deleted by accident ---------------- */
    r = await amber(["confluence", "pull", "100000001"], env);
    eq("re-pull: exit 0", r.code, 0);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/⟦macro\.warning#1⟧\n?/, "") + "\n\nSomething else.\n");
    r = await amber(["confluence", "push", "100000001"], env);
    eq("dropped marker: exit 2", r.code, 2);
    ok("dropped marker: names the block", r.err.indexOf("macro.warning") !== -1, r.err);
    eq("dropped marker: nothing written", fake.pages["100000001"].version.number, 7);

    /* ---------------- the doctor on the same instance ---------------- */
    r = await amber(["confluence", "doctor", "100000001"], env);
    eq("doctor: exit 0", r.code, 0);
    ok("doctor: byte for byte", r.out.indexOf("byte for byte") !== -1, r.out);
    ok("doctor: wrote nothing", fake.requests.filter(function (q) { return q.method !== "GET"; }).length === 1,
       fake.requests.filter(function (q) { return q.method !== "GET"; }).length + " writes in total");
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ---------------- report ---------------- */
  console.log("");
  if (fails.length) {
    console.log("FAILURES (" + fails.length + "):\n");
    fails.forEach(function (f) {
      console.log("  ✗ " + f.name);
      console.log("      got:  " + JSON.stringify(f.got).slice(0, 500));
      console.log("      want: " + JSON.stringify(f.want).slice(0, 300));
    });
    console.log("");
  }
  console.log("passed " + pass + ", failed " + fail);
  process.exit(fail ? 1 : 0);
})();
