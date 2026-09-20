const C = require("../src/converter.js");

/* A page shaped like the real one: warning panel, glossary table, nested
 * lists, a status lozenge inside a table cell, an attachment, a jira link,
 * a TOC macro and an expand macro wrapping rich text. */
const PAGE = [
  "<p>",
  '<ac:structured-macro ac:name="toc" ac:schema-version="1" ac:macro-id="t0" />',
  "</p>",
  "<h1>Onboarding (Lagoon)</h1>",
  "<p><em>pageId 100000001 · space DEMO</em></p>",
  '<ac:structured-macro ac:name="warning" ac:schema-version="1" ac:macro-id="w1">',
  "<ac:rich-text-body><p>Company security policy: never store ",
  "<strong>passwords, tokens or keys</strong> in Confluence.</p></ac:rich-text-body>",
  "</ac:structured-macro>",
  "<h2>Owners</h2>",
  "<ul>",
  "<li><p>Analyst: John Doe</p></li>",
  "<li><p>Team</p><ul><li><p>backend</p></li><li><p>frontend</p></li></ul></li>",
  "</ul>",
  "<h2>Glossary</h2>",
  "<table><tbody>",
  "<tr><th>Term</th><th>Definition</th></tr>",
  "<tr><td>Account</td><td>Personal account: the web UI after sign-in</td></tr>",
  "<tr><td>PII</td><td>name, e-mail, phone &mdash; entered by the user</td></tr>",
  "</tbody></table>",
  "<h2>Use Cases</h2>",
  "<table><tbody>",
  "<tr><th>#</th><th>UC</th><th>Status</th></tr>",
  "<tr><td>UC1</td><td>Sign-up from the landing page</td><td>",
  '<ac:structured-macro ac:name="status" ac:schema-version="1" ac:macro-id="s1">',
  '<ac:parameter ac:name="colour">Green</ac:parameter>',
  '<ac:parameter ac:name="title">DONE</ac:parameter>',
  "</ac:structured-macro>",
  "</td></tr>",
  "<tr><td>UC2</td><td>Finish the form</td><td>",
  '<ac:structured-macro ac:name="status" ac:schema-version="1" ac:macro-id="s2">',
  '<ac:parameter ac:name="colour">Yellow</ac:parameter>',
  '<ac:parameter ac:name="title">WIP</ac:parameter>',
  "</ac:structured-macro>",
  "</td></tr>",
  "</tbody></table>",
  "<h2>Diagram</h2>",
  '<ac:image ac:height="400"><ri:attachment ri:filename="flow.png" /></ac:image>',
  "<h2>Details</h2>",
  '<ac:structured-macro ac:name="expand" ac:schema-version="1" ac:macro-id="e1">',
  '<ac:parameter ac:name="title">Show risks</ac:parameter>',
  "<ac:rich-text-body><p>Blocking after the demo is handled by engineering.</p>",
  "<ul><li><p>onboarding is out of MVP scope</p></li></ul></ac:rich-text-body>",
  "</ac:structured-macro>",
  "<p>Ticket: ",
  '<ac:structured-macro ac:name="jira" ac:schema-version="1" ac:macro-id="j1">',
  '<ac:parameter ac:name="key">DEMO-101</ac:parameter>',
  "</ac:structured-macro>",
  "</p>",
].join("");

let bad = 0;
function check(name, cond, extra) {
  if (cond) { console.log("  ✓ " + name); return; }
  bad++;
  console.log("  ✗ " + name + (extra ? "\n      " + extra : ""));
}

console.log("\n=== pass 1: storage -> markdown ===");
const p1 = C.toMarkdown(PAGE);
console.log("\n--- markdown the editor would show ---\n");
console.log(p1.markdown);
console.log("\n--- extracted opaque blocks ---");
p1.macros.forEach(m => console.log("  " + m.token + "  (" + m.xml.length + " bytes)"));

check("all 7 opaque blocks lifted", p1.macros.length === 7, "got " + p1.macros.length);
check("no raw ac: left in markdown", !/<ac:|<ri:/.test(p1.markdown));
check("tables converted, not opaque", p1.markdown.includes("| Term | Definition |"));
check("nested list indented", p1.markdown.includes("  - backend"));

console.log("\n=== pass 2: markdown -> storage ===");
const s2 = C.toStorage(p1.markdown, p1.macros);
p1.macros.forEach(m => {
  check("verbatim: " + m.token, s2.includes(m.xml));
});

console.log("\n=== pass 3: idempotency (storage -> md -> storage -> md) ===");
const p3 = C.toMarkdown(s2);
check("markdown stable across a full cycle", p3.markdown === p1.markdown,
      p3.markdown === p1.markdown ? "" : "drifted");
check("macro count stable", p3.macros.length === p1.macros.length,
      p3.macros.length + " vs " + p1.macros.length);

const s4 = C.toStorage(p3.markdown, p3.macros);
check("storage stable across a second cycle", s4 === s2, s4 === s2 ? "" : "drifted");

console.log("\n=== pass 4: a realistic human edit ===");
let edited = p1.markdown
  .replace("John Doe", "J. Doe")
  .replace("| UC2 | Finish the form |", "| UC2 | Finish the sign-up form |")
  .replace("## Details", "## Details and risks");
edited += "\n\n## New section\n\n- added by hand\n- and one more item\n";

const s5 = C.toStorage(edited, p1.macros);
check("edit: nothing reported missing", C.missingMacros(edited, p1.macros).length === 0);
p1.macros.forEach(m => {
  check("edit keeps verbatim: " + m.token, s5.includes(m.xml));
});
check("edit: new heading landed", s5.includes("<h2>New section</h2>"));
check("edit: new list landed", s5.includes("added by hand"));
check("edit: renamed analyst", s5.includes("J. Doe"));

console.log("\n=== pass 5: dropping a macro is reported, not silent ===");
const dropped = p1.markdown.replace("⟦macro.warning#1⟧", "");
const gone = C.missingMacros(dropped, p1.macros);
check("exactly one reported", gone.length === 1, "got " + gone.length);
check("it is the warning panel", gone.length === 1 && gone[0].label === "macro.warning");

console.log("");
console.log(bad ? "FAILED: " + bad + " check(s)" : "ALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
