/* The diff has to stay honest on small edits and cheap on long pages.
 * Both were broken once: a quadratic table spent a second and a quarter of a
 * gigabyte on six thousand lines to report a single changed word. */

const { diffLines, renderDiff, parseArgs } = require("../bin/amber.js");

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

function counts(changes) {
  return {
    same: changes.filter(function (c) { return c.kind === " "; }).length,
    removed: changes.filter(function (c) { return c.kind === "-"; }).length,
    added: changes.filter(function (c) { return c.kind === "+"; }).length,
  };
}

function page(n, edit) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(edit === i ? "line " + i + " EDITED" : "line " + i + " of the page");
  return lines.join("\n");
}

/* ---------------- 1. what changed ---------------- */
{
  const c = counts(diffLines("a\nb\nc", "a\nB\nc"));
  eq("one line rewritten: removed", c.removed, 1);
  eq("one line rewritten: added", c.added, 1);
  eq("the rest is untouched", c.same, 2);

  eq("append", counts(diffLines("a\nb", "a\nb\nc")).added, 1);
  eq("append removes nothing", counts(diffLines("a\nb", "a\nb\nc")).removed, 0);

  eq("delete one of sixty", counts(diffLines(page(60), page(60).split("\n").filter(function (_, i) { return i !== 30; }).join("\n"))).removed, 1);
  eq("delete adds nothing", counts(diffLines(page(60), page(60).split("\n").filter(function (_, i) { return i !== 30; }).join("\n"))).added, 0);

  const identical = diffLines("x\ny", "x\ny");
  ok("identical input reports no change", identical.every(function (c2) { return c2.kind === " "; }));
  eq("identical input renders as nothing", renderDiff(identical, 2), null);
}

/* ---------------- 2. edits at the edges ---------------- */
{
  eq("insert at the very top", counts(diffLines("b\nc", "a\nb\nc")).added, 1);
  eq("remove the very last line", counts(diffLines("a\nb\nc", "a\nb")).removed, 1);

  const emptied = counts(diffLines("a\nb\nc", ""));
  eq("emptying the page removes every line", emptied.removed, 3);
}

/* ---------------- 3. long pages stay cheap ---------------- */
{
  const before = page(20000);
  const after = page(20000, 10000);

  const started = Date.now();
  const changes = diffLines(before, after);
  const took = Date.now() - started;

  const c = counts(changes);
  eq("20000 lines, one edit: removed", c.removed, 1);
  eq("20000 lines, one edit: added", c.added, 1);
  ok("20000 lines diff in under a second", took < 1000, took + " ms");

  /* Quadratic behaviour shows up as time growing by the square. Doubling the
   * page must not come close to quadrupling the cost. */
  const bigStarted = Date.now();
  diffLines(page(40000), page(40000, 20000));
  const bigTook = Date.now() - bigStarted;
  ok("doubling the page does not square the cost", bigTook < Math.max(200, took * 6),
     took + " ms then " + bigTook + " ms");
}

/* ---------------- 4. two pages with nothing in common ---------------- */
{
  const a = [], b = [];
  for (let i = 0; i < 4000; i++) { a.push("aaa" + i); b.push("bbb" + i); }

  const started = Date.now();
  const c = counts(diffLines(a.join("\n"), b.join("\n")));
  const took = Date.now() - started;

  eq("everything removed", c.removed, 4000);
  eq("everything added", c.added, 4000);
  ok("the worst case is still fast", took < 2000, took + " ms");
}

/* ---------------- 5. context rendering ---------------- */
{
  const rendered = renderDiff(diffLines(page(200), page(200, 100)), 2);
  ok("renders the changed lines", rendered.indexOf("EDITED") !== -1, rendered);
  ok("keeps a little context", rendered.indexOf("line 99 of the page") !== -1, rendered);
  ok("leaves the rest out", rendered.indexOf("line 10 of the page") === -1, rendered);
  ok("one edit needs no gap marker", rendered.indexOf("...") === -1, rendered);

  /* Two edits far apart: the untouched middle is replaced by a marker
   * rather than printed in full. */
  const far = page(200).split("\n");
  far[20] = "line 20 EDITED";
  far[180] = "line 180 EDITED";
  const twoEdits = renderDiff(diffLines(page(200), far.join("\n")), 2);
  ok("both edits shown", twoEdits.indexOf("line 20 EDITED") !== -1 && twoEdits.indexOf("line 180 EDITED") !== -1, twoEdits);
  ok("the middle is elided", twoEdits.indexOf("...") !== -1, twoEdits);
  ok("the elided middle is not printed", twoEdits.indexOf("line 100 of the page") === -1, twoEdits);
}

/* ---------------- 6. argument parsing ---------------- */
{
  const a = parseArgs(["confluence", "push", "123", "-m", "why", "--force"]);
  eq("command words kept in order", a.rest.join(" "), "confluence push 123");
  eq("message read", a.message, "why");
  eq("force read", a.force, true);
  eq("json defaults off", a.json, false);
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
