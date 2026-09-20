const C = require("../src/converter.js");

let pass = 0, fail = 0;
const fails = [];

function eq(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  fails.push({ name, got, want });
}
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  fails.push({ name, got: detail || "false", want: "true" });
}
function has(name, hay, needle) {
  ok(name + " :: contains " + JSON.stringify(needle), String(hay).includes(needle),
     "…" + String(hay).slice(0, 400) + "…");
}

/* ---------------- 1. macros survive byte-for-byte ---------------- */

const INFO_MACRO =
  '<ac:structured-macro ac:name="info" ac:schema-version="1" ac:macro-id="a1">' +
  '<ac:rich-text-body><p>Do not store <strong>passwords</strong> in Confluence.</p></ac:rich-text-body>' +
  "</ac:structured-macro>";

const STATUS_MACRO =
  '<ac:structured-macro ac:name="status" ac:schema-version="1" ac:macro-id="b2">' +
  '<ac:parameter ac:name="colour">Green</ac:parameter>' +
  '<ac:parameter ac:name="title">DONE</ac:parameter>' +
  "</ac:structured-macro>";

const ATTACH =
  '<ac:image ac:height="250"><ri:attachment ri:filename="scheme.png" /></ac:image>';

const JIRA_MACRO =
  '<ac:structured-macro ac:name="jira" ac:schema-version="1" ac:macro-id="c3">' +
  '<ac:parameter ac:name="key">DEMO-101</ac:parameter>' +
  "</ac:structured-macro>";

{
  const storage =
    "<h1>Onboarding</h1>" +
    INFO_MACRO +
    "<p>Status: " + STATUS_MACRO + " done</p>" +
    "<h2>Diagram</h2>" +
    ATTACH +
    "<p>Ticket " + JIRA_MACRO + "</p>";

  const { markdown, macros } = C.toMarkdown(storage);

  eq("macro count", macros.length, 4);
  has("md: heading", markdown, "# Onboarding");
  has("md: info token on its own line", markdown, "⟦macro.info#1⟧");
  has("md: status token inline", markdown, "Status: ⟦macro.status#1⟧ done");
  has("md: image token", markdown, "⟦image#1⟧");
  has("md: jira token", markdown, "⟦macro.jira#1⟧");

  const back = C.toStorage(markdown, macros);
  has("roundtrip: info macro verbatim", back, INFO_MACRO);
  has("roundtrip: status macro verbatim", back, STATUS_MACRO);
  has("roundtrip: attachment verbatim", back, ATTACH);
  has("roundtrip: jira macro verbatim", back, JIRA_MACRO);
  has("roundtrip: h1", back, "<h1>Onboarding</h1>");
  has("roundtrip: h2", back, "<h2>Diagram</h2>");
}

/* ---------------- 2. edited text keeps macros ---------------- */
{
  const storage = "<p>Before</p>" + INFO_MACRO + "<p>After</p>";
  const { markdown, macros } = C.toMarkdown(storage);

  // Simulate a human edit: rewrite prose, move the macro to the end.
  const edited = markdown
    .replace("Before", "Rewritten text above")
    .replace("After", "And below as well");

  const back = C.toStorage(edited, macros);
  has("edit: macro still verbatim", back, INFO_MACRO);
  has("edit: new prose present", back, "Rewritten text above");
  has("edit: second para present", back, "And below as well");
  eq("edit: nothing reported missing", C.missingMacros(edited, macros).length, 0);
}

/* ---------------- 3. deleting a token is detected ---------------- */
{
  const storage = "<p>x</p>" + INFO_MACRO + STATUS_MACRO;
  const { markdown, macros } = C.toMarkdown(storage);
  const edited = markdown.replace("⟦macro.info#1⟧", "");
  const gone = C.missingMacros(edited, macros);
  eq("missing: one dropped", gone.length, 1);
  eq("missing: it is the info macro", gone[0].label, "macro.info");
}

/* ---------------- 4. headings / paragraphs / emphasis ---------------- */
{
  const storage =
    "<h1>T</h1><h3>Sub</h3>" +
    "<p>Plain <strong>bold</strong> and <em>italic</em> and <code>code</code>.</p>" +
    '<p><a href="https://dev.example.com/signup">landing</a></p>';
  const { markdown } = C.toMarkdown(storage);
  has("h1", markdown, "# T");
  has("h3", markdown, "### Sub");
  has("bold", markdown, "**bold**");
  has("italic", markdown, "_italic_");
  has("code", markdown, "`code`");
  has("link", markdown, "[landing](https://dev.example.com/signup)");

  const back = C.toStorage(markdown, []);
  has("back: strong", back, "<strong>bold</strong>");
  has("back: em", back, "<em>italic</em>");
  has("back: code", back, "<code>code</code>");
  has("back: link", back, '<a href="https://dev.example.com/signup">landing</a>');
}

/* ---------------- 5. lists incl. nesting ---------------- */
{
  const storage =
    "<ul><li><p>Analyst: John Doe</p></li>" +
    "<li><p>Engineers</p><ul><li><p>backend</p></li><li><p>frontend</p></li></ul></li></ul>" +
    "<ol><li><p>one</p></li><li><p>two</p></li></ol>";
  const { markdown } = C.toMarkdown(storage);
  has("ul item", markdown, "- Analyst: John Doe");
  has("nested item", markdown, "  - backend");
  has("ol item", markdown, "1. one");
  has("ol second", markdown, "2. two");

  const back = C.toStorage(markdown, []);
  has("back: ul", back, "<ul>");
  has("back: nested ul", back, "<li><p>Engineers</p><ul>");
  has("back: ol", back, "<ol>");
}

/* ---------------- 6. simple table -> md -> storage ---------------- */
{
  const storage =
    "<table><tbody>" +
    "<tr><th>Term</th><th>Definition</th></tr>" +
    "<tr><td>Account</td><td>Personal account</td></tr>" +
    "<tr><td>PII</td><td>Personal data</td></tr>" +
    "</tbody></table>";
  const { markdown } = C.toMarkdown(storage);
  has("table head", markdown, "| Term | Definition |");
  has("table sep", markdown, "|---|---|");
  has("table row", markdown, "| Account | Personal account |");

  const back = C.toStorage(markdown, []);
  has("back: th", back, "<th>Term</th>");
  has("back: td", back, "<td>Personal account</td>");
}

/* ---------------- 7. table with a macro stays opaque ---------------- */
{
  const storage =
    "<table><tbody><tr><th>Task</th><th>Status</th></tr>" +
    "<tr><td>UC1</td><td>" + STATUS_MACRO + "</td></tr></tbody></table>";
  const { markdown, macros } = C.toMarkdown(storage);
  // The macro is lifted out first, so the remaining table is inline-only
  // and converts normally -- with the token living in the cell.
  has("macro-in-table: token in cell", markdown, "⟦macro.status#1⟧");
  const back = C.toStorage(markdown, macros);
  has("macro-in-table: verbatim on the way back", back, STATUS_MACRO);
}

/* ---------------- 8. entities ---------------- */
{
  const storage = "<p>a&nbsp;b &amp; c &lt;d&gt; &mdash; &laquo;quote&raquo;</p>";
  const { markdown } = C.toMarkdown(storage);
  has("nbsp decoded", markdown, "a b");
  has("amp decoded", markdown, "& c");
  has("lt gt decoded", markdown, "<d>");
  has("mdash decoded", markdown, "—");
  has("laquo decoded", markdown, "«quote»");

  const back = C.toStorage(markdown, []);
  has("back: amp re-encoded", back, "&amp;");
  has("back: lt re-encoded", back, "&lt;d&gt;");
}

/* ---------------- 9. blockquote + hr + code block ---------------- */
{
  const storage =
    "<blockquote><p>Important</p></blockquote><hr /><pre>line1\nline2</pre>";
  const { markdown } = C.toMarkdown(storage);
  has("quote", markdown, "> Important");
  has("hr", markdown, "---");
  has("pre", markdown, "```\nline1\nline2\n```");

  const back = C.toStorage(markdown, []);
  has("back: blockquote", back, "<blockquote>");
  has("back: hr", back, "<hr />");
  has("back: pre", back, "<pre>line1\nline2</pre>");
}

/* ---------------- 10. unbalanced / hostile input does not hang ---------------- */
{
  const bad = '<ac:structured-macro ac:name="x"><p>never closed';
  const r = C.toMarkdown(bad);
  ok("unbalanced macro survives", typeof r.markdown === "string");

  const attrGt = '<ac:structured-macro ac:name="a>b"><ac:parameter>v</ac:parameter></ac:structured-macro>';
  const r2 = C.toMarkdown(attrGt);
  eq("quote-aware tag scan", r2.macros.length, 1);
  has("quote-aware verbatim", C.toStorage(r2.markdown, r2.macros), attrGt);
}

/* ---------------- 11. token reuse / duplication ---------------- */
{
  const storage = "<p>a</p>" + STATUS_MACRO;
  const { markdown, macros } = C.toMarkdown(storage);
  const dup = markdown + "\n\n⟦macro.status#1⟧";
  const back = C.toStorage(dup, macros);
  const count = back.split(STATUS_MACRO).length - 1;
  eq("duplicated token emits macro twice", count, 2);
}

/* ---------------- 12. non-ASCII content survives ----------------
 * Confluence Data Center is mostly run inside companies whose pages are
 * not written in English. A converter that mangles non-ASCII text is
 * useless to them, so the alphabets are covered explicitly. */
{
  const storage =
    "<h2>\u041e\u0442\u0447\u0451\u0442 \u043e \u0432\u043d\u0435\u0434\u0440\u0435\u043d\u0438\u0438</h2>" +
    "<p>\u0421\u0442\u0430\u0442\u0443\u0441: <strong>\u0433\u043e\u0442\u043e\u0432\u043e</strong></p>" +
    "<table><tbody><tr><th>Begriff</th><th>Erkl\u00e4rung</th></tr>" +
    "<tr><td>Pr\u00fcfung</td><td>Qualit\u00e4tssicherung</td></tr></tbody></table>" +
    "<p>\u6587\u66f8\u30c6\u30b9\u30c8</p>";
  const { markdown, macros } = C.toMarkdown(storage);

  has("cyrillic heading", markdown, "## \u041e\u0442\u0447\u0451\u0442 \u043e \u0432\u043d\u0435\u0434\u0440\u0435\u043d\u0438\u0438");
  has("cyrillic bold", markdown, "**\u0433\u043e\u0442\u043e\u0432\u043e**");
  has("umlauts in table", markdown, "| Pr\u00fcfung | Qualit\u00e4tssicherung |");
  has("cjk paragraph", markdown, "\u6587\u66f8\u30c6\u30b9\u30c8");

  const back = C.toStorage(markdown, macros);
  has("back: cyrillic heading", back, "<h2>\u041e\u0442\u0447\u0451\u0442 \u043e \u0432\u043d\u0435\u0434\u0440\u0435\u043d\u0438\u0438</h2>");
  has("back: umlaut cell", back, "<td>Qualit\u00e4tssicherung</td>");
  has("back: cjk", back, "\u6587\u66f8\u30c6\u30b9\u30c8");
}

/* ---------------- report ---------------- */
console.log("");
if (fails.length) {
  console.log("FAILURES (" + fails.length + "):\n");
  fails.forEach(f => {
    console.log("  ✗ " + f.name);
    console.log("      got:  " + JSON.stringify(f.got).slice(0, 300));
    console.log("      want: " + JSON.stringify(f.want).slice(0, 300));
  });
  console.log("");
}
console.log(`passed ${pass}, failed ${fail}`);
process.exit(fail ? 1 : 0);
