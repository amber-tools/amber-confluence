#!/usr/bin/env node
/* amber — edit self-hosted Confluence pages as Markdown.
 *
 *   amber confluence pull <page>    page to Markdown on disk
 *   amber confluence diff <page>    what push would change
 *   amber confluence push <page>    Markdown back to Confluence
 *   amber confluence status [page]  how local copies compare to the server
 *
 * <page> is a page id or any Confluence URL containing one.
 */

"use strict";

const config = require("../src/config.js");
const C = require("../src/converter.js");
const { createClient } = require("../src/client.js");
const { createStore, digestOf } = require("../src/store.js");
const { applyTrust } = require("../src/trust.js");
const doctor = require("../src/doctor.js");

const USAGE = [
  "amber — edit self-hosted Confluence pages as Markdown",
  "",
  "  amber confluence pull <page>              write the page to <pages dir>/<id>.md",
  "  amber confluence diff <page>              show what push would change",
  '  amber confluence push <page> [-m "why"]   publish the edited Markdown',
  "  amber confluence status [page]            compare local copies with the server",
  "  amber confluence doctor [page]            check that everything works here, without writing",
  "",
  "Options",
  "  -m, --message <text>   version comment shown in the page history",
  "      --force            publish despite a refusal (see below)",
  "      --json             machine-readable output",
  "      --share            doctor only: a report safe to paste publicly",
  "",
  "Push refuses, and only --force overrides, when:",
  "  - the page changed on the server after you pulled it",
  "  - an opaque block marker is missing from the Markdown",
  "",
  "Configuration: ~/.config/amber/config.toml",
  "",
  "  [confluence]",
  '  url  = "https://confluence.example.com"',
  '  user = "you@example.com"',
  "",
  "Credentials come from the OS keychain or from AMBER_CONFLUENCE_TOKEN /",
  "AMBER_CONFLUENCE_PASSWORD. They are never read from the config file.",
].join("\n");

function parseArgs(argv) {
  const out = { rest: [], force: false, json: false, message: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") out.force = true;
    else if (a === "--json") out.json = true;
    else if (a === "--share") out.share = true;
    else if (a === "-m" || a === "--message") out.message = argv[++i];
    else if (a === "-h" || a === "--help") out.help = true;
    else out.rest.push(a);
  }
  return out;
}

/* Line diff.
 *
 * A plain longest-common-subsequence table is quadratic, and wiki pages get
 * long: six thousand lines cost a second and a quarter of a gigabyte, twenty
 * thousand cost minutes. Almost none of that work is useful, because a real
 * edit touches a handful of lines in a page that is otherwise identical.
 *
 * So the work is cut down before any table is built. Identical head and tail
 * are matched directly. What remains is split at lines that occur exactly
 * once on each side — they can only correspond to each other, so they are
 * safe anchors. Only the small regions between anchors reach the table, and
 * a region too large even then is reported as a whole block rather than
 * spending minutes to say the same thing in more detail.
 */

var LCS_CELL_LIMIT = 4e6;

function lcsDiff(a, b, out) {
  var n = a.length, m = b.length;

  var lcs = [];
  for (var i = 0; i <= n; i++) lcs.push(new Int32Array(m + 1));
  for (var i = n - 1; i >= 0; i--) {
    for (var j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  var x = 0, y = 0;
  while (x < n && y < m) {
    if (a[x] === b[y]) { out.push({ kind: " ", text: a[x] }); x++; y++; }
    else if (lcs[x + 1][y] >= lcs[x][y + 1]) { out.push({ kind: "-", text: a[x] }); x++; }
    else { out.push({ kind: "+", text: b[y] }); y++; }
  }
  while (x < n) out.push({ kind: "-", text: a[x++] });
  while (y < m) out.push({ kind: "+", text: b[y++] });
}

/* Lines appearing exactly once in both halves, in an order both agree on. */
function anchors(a, b) {
  function countOf(lines) {
    var c = Object.create(null);
    lines.forEach(function (l) { c[l] = (c[l] || 0) + 1; });
    return c;
  }
  var ca = countOf(a), cb = countOf(b);

  var indexInB = Object.create(null);
  b.forEach(function (l, j) { if (cb[l] === 1) indexInB[l] = j; });

  var pairs = [];
  a.forEach(function (l, i) {
    if (ca[l] === 1 && cb[l] === 1) pairs.push([i, indexInB[l]]);
  });

  /* Longest run whose positions rise on both sides. */
  var tails = [], link = [], best = [];
  pairs.forEach(function (pair, k) {
    var lo = 0, hi = tails.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (best[tails[mid]][1] < pair[1]) lo = mid + 1; else hi = mid;
    }
    best[k] = pair;
    link[k] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = k;
  });

  var chain = [];
  for (var k = tails.length ? tails[tails.length - 1] : -1; k !== -1 && k !== undefined; k = link[k]) {
    chain.push(best[k]);
  }
  return chain.reverse();
}

function diffRegion(a, b, out) {
  if (!a.length && !b.length) return;
  if (!a.length) { b.forEach(function (l) { out.push({ kind: "+", text: l }); }); return; }
  if (!b.length) { a.forEach(function (l) { out.push({ kind: "-", text: l }); }); return; }

  if (a.length * b.length <= LCS_CELL_LIMIT) return lcsDiff(a, b, out);

  var found = anchors(a, b);
  if (!found.length) {
    a.forEach(function (l) { out.push({ kind: "-", text: l }); });
    b.forEach(function (l) { out.push({ kind: "+", text: l }); });
    return;
  }

  var x = 0, y = 0;
  found.forEach(function (pair) {
    diffRegion(a.slice(x, pair[0]), b.slice(y, pair[1]), out);
    out.push({ kind: " ", text: a[pair[0]] });
    x = pair[0] + 1;
    y = pair[1] + 1;
  });
  diffRegion(a.slice(x), b.slice(y), out);
}

function diffLines(before, after) {
  var a = before.split("\n");
  var b = after.split("\n");
  var out = [];

  var head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  var ta = a.length, tb = b.length;
  while (ta > head && tb > head && a[ta - 1] === b[tb - 1]) { ta--; tb--; }

  for (var i = 0; i < head; i++) out.push({ kind: " ", text: a[i] });
  diffRegion(a.slice(head, ta), b.slice(head, tb), out);
  for (var j = ta; j < a.length; j++) out.push({ kind: " ", text: a[j] });

  return out;
}

/* Only changed lines matter, with a little context around them. */
function renderDiff(changes, context) {
  const keep = new Set();
  changes.forEach(function (c, idx) {
    if (c.kind === " ") return;
    for (let k = idx - context; k <= idx + context; k++) if (k >= 0 && k < changes.length) keep.add(k);
  });
  if (!keep.size) return null;

  const lines = [];
  let last = -1;
  Array.from(keep).sort(function (x, y) { return x - y; }).forEach(function (idx) {
    if (last !== -1 && idx > last + 1) lines.push("  ...");
    lines.push(changes[idx].kind + " " + changes[idx].text);
    last = idx;
  });
  return lines.join("\n");
}

function fail(message, code) {
  console.error(message);
  process.exit(code || 1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [group, command, pageRef] = args.rest;

  if (args.help || !group) {
    console.log(USAGE);
    process.exit(group ? 0 : 1);
  }
  if (group !== "confluence") {
    fail('Unknown command group "' + group + '". The only group today is: confluence');
  }
  if (["pull", "push", "diff", "status", "doctor"].indexOf(command) === -1) {
    fail('Unknown command "' + (command || "") + '". Try: pull, push, diff, status, doctor');
  }

  /* The doctor reports a broken configuration rather than failing on it,
   * so it runs before the configuration is loaded. */
  if (command === "doctor") {
    const report = await doctor.runDoctor({
      loadSession: function () { return config.load(); },
      pageRef: pageRef,
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(doctor.render(report, args.share));
    process.exit(doctor.exitCode(report));
  }
  if (!pageRef && command !== "status") {
    fail("Which page? Pass a page id or a Confluence URL.");
  }

  let session;
  try {
    session = config.load();
    applyTrust({ caFile: session.caFile });
  } catch (e) {
    fail(e.message);
  }

  const client = createClient(session);
  const store = createStore(session.pagesDir);

  if (command === "pull") {
    const page = await client.pull(pageRef);
    const saved = store.save(Object.assign({}, page, { digest: digestOf(page.markdown) }));

    if (args.json) return console.log(JSON.stringify({ page: page.pageId, version: page.version, file: saved.markdownFile }));

    console.log(page.title + "  (v" + page.version + ", space " + page.spaceKey + ")");
    console.log(saved.markdownFile);
    console.log(
      page.macros.length
        ? page.macros.length + " opaque block(s): " + page.macros.map(function (m) { return m.token; }).join(" ")
        : "no opaque blocks"
    );
    if (page.macros.length) {
      console.log("Markers stand for markup Markdown cannot express. Move or delete them, but do not rewrite them.");
    }
    return;
  }

  const pageId = client.pageIdFrom(pageRef || "");
  const local = store.load(pageId);

  if (command === "diff") {
    if (!local) fail("No local copy of page " + pageId + ". Pull it first.");
    const live = await client.pull(pageId);
    const changes = diffLines(live.markdown, local.markdown);
    const rendered = renderDiff(changes, 2);

    if (args.json) {
      return console.log(JSON.stringify({
        page: pageId,
        localVersion: local.meta.version,
        liveVersion: live.version,
        changed: Boolean(rendered),
      }));
    }

    if (live.version > local.meta.version) {
      console.log("Note: the server is at v" + live.version + ", your copy came from v" + local.meta.version + ".");
    }
    console.log(rendered || "No changes: the local copy matches the page.");
    return;
  }

  if (command === "status") {
    const ids = pageRef ? [pageId] : store.list();
    if (!ids.length) return console.log("No pages pulled yet. Try: amber confluence pull <page>");

    for (const id of ids) {
      const copy = store.load(id);
      if (!copy) { console.log(id + "  not pulled"); continue; }
      const s = await client.status(id, copy.meta, copy.markdown);
      const parts = ["v" + s.localVersion + " local", "v" + s.liveVersion + " on the server"];
      if (s.behind) parts.push("changed by " + (s.lastEditedBy || "someone else"));
      if (s.missingMacros.length) parts.push(s.missingMacros.length + " opaque block(s) missing");
      console.log(id + "  " + s.title + "\n    " + parts.join(", "));
    }
    return;
  }

  /* push */
  if (!local) fail("No local copy of page " + pageId + ". Pull it first.");

  let result;
  try {
    result = await client.push(pageId, local.meta, local.markdown, {
      force: args.force,
      message: args.message,
    });
  } catch (e) {
    /* Both refusals are expected outcomes, not crashes: exit 2 so a script
     * can tell them apart from a broken run. */
    if (e.code === "STALE" || e.code === "MACROS_MISSING") fail(e.message, 2);
    throw e;
  }

  if (result.unchanged) {
    if (args.json) return console.log(JSON.stringify(result));
    return console.log("Nothing to publish: " + (result.title || "the page") + " is unchanged since the pull (v" + result.fromVersion + ").");
  }

  /* The local copy becomes what the page now holds, with a fresh layout,
   * so the next edit is compared against the published page rather than
   * against the copy from before this push. */
  const published = C.toMarkdown(result.storage);
  store.save({
    pageId: pageId,
    title: result.title,
    spaceKey: local.meta.spaceKey,
    version: result.toVersion,
    markdown: published.markdown,
    macros: published.macros,
    layout: published.layout,
  });

  if (args.json) return console.log(JSON.stringify(result));

  console.log(result.title + "  v" + result.fromVersion + " -> v" + result.toVersion);
  console.log(result.url);
  if (result.forcedOverStale) console.log("Forced over a newer version: someone else's edit was overwritten.");
  if (result.removedMacros) console.log("Forced: " + result.removedMacros + " opaque block(s) removed from the page.");
}

/* Run as a command; required as a module by the tests, which exercise the
 * diff directly rather than through a Confluence instance. */
if (require.main === module) {
  main().catch(function (e) {
    fail(e && e.message ? e.message : String(e));
  });
}

module.exports = { diffLines: diffLines, renderDiff: renderDiff, parseArgs: parseArgs };
