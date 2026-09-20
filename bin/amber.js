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
const { createClient } = require("../src/client.js");
const { createStore, digestOf } = require("../src/store.js");

const USAGE = [
  "amber — edit self-hosted Confluence pages as Markdown",
  "",
  "  amber confluence pull <page>              write the page to <pages dir>/<id>.md",
  "  amber confluence diff <page>              show what push would change",
  '  amber confluence push <page> [-m "why"]   publish the edited Markdown',
  "  amber confluence status [page]            compare local copies with the server",
  "",
  "Options",
  "  -m, --message <text>   version comment shown in the page history",
  "      --force            publish despite a refusal (see below)",
  "      --json             machine-readable output",
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
    else if (a === "-m" || a === "--message") out.message = argv[++i];
    else if (a === "-h" || a === "--help") out.help = true;
    else out.rest.push(a);
  }
  return out;
}

/* Line diff via the usual longest-common-subsequence table. Page-sized
 * inputs make the quadratic cost irrelevant, and it keeps the tool free
 * of a dependency for something this small. */
function diffLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length, m = b.length;

  const lcs = [];
  for (let i = 0; i <= n; i++) lcs.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: " ", text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: "-", text: a[i] }); i++; }
    else { out.push({ kind: "+", text: b[j] }); j++; }
  }
  while (i < n) out.push({ kind: "-", text: a[i++] });
  while (j < m) out.push({ kind: "+", text: b[j++] });
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
  if (["pull", "push", "diff", "status"].indexOf(command) === -1) {
    fail('Unknown command "' + (command || "") + '". Try: pull, push, diff, status');
  }
  if (!pageRef && command !== "status") {
    fail("Which page? Pass a page id or a Confluence URL.");
  }

  let session;
  try {
    session = config.load();
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

  store.save({
    pageId: pageId,
    title: result.title,
    spaceKey: local.meta.spaceKey,
    version: result.toVersion,
    markdown: local.markdown,
    macros: local.meta.macros,
  });

  if (args.json) return console.log(JSON.stringify(result));

  console.log(result.title + "  v" + result.fromVersion + " -> v" + result.toVersion);
  console.log(result.url);
  if (result.forcedOverStale) console.log("Forced over a newer version: someone else's edit was overwritten.");
  if (result.removedMacros) console.log("Forced: " + result.removedMacros + " opaque block(s) removed from the page.");
}

main().catch(function (e) {
  fail(e && e.message ? e.message : String(e));
});
