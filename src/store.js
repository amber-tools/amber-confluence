/* Local copies of pulled pages.
 *
 * A page on disk is an ordinary Markdown file a person can open in any
 * editor. What the tool needs to know about it — which page it is, which
 * version it came from — lives in a small header at the top, so the file
 * is self-describing: moving it, copying it or committing it to git keeps
 * it usable.
 *
 * The opaque blocks live in a sidecar file rather than the header. They
 * are raw Confluence markup, sometimes kilobytes of it, and a header no
 * one can read is a header people delete.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FENCE = "---";

/* A deliberately flat header: `key: value`, strings only. Anything more
 * would be a YAML parser, and this file does not need one. */
function formatHeader(meta) {
  const lines = [
    FENCE,
    "amber: confluence",
    "page_id: " + meta.pageId,
    "title: " + String(meta.title || "").replace(/\r?\n/g, " "),
    "space: " + (meta.spaceKey || ""),
    "version: " + meta.version,
    "pulled_at: " + meta.pulledAt,
    "digest: " + meta.digest,
    FENCE,
    "",
  ];
  return lines.join("\n");
}

function parseHeader(text) {
  if (!text.startsWith(FENCE)) return { meta: null, markdown: text };

  const end = text.indexOf("\n" + FENCE, FENCE.length);
  if (end === -1) return { meta: null, markdown: text };

  const head = text.slice(FENCE.length, end);
  /* Drop the newline that ends the fence line, plus the blank line a
   * hand-written header may carry after it. */
  const body = text.slice(end + FENCE.length + 1).replace(/^\r?\n(?:\r?\n)?/, "");

  const meta = {};
  head.split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2];
  });

  if (meta.amber !== "confluence") return { meta: null, markdown: text };

  return {
    meta: {
      pageId: meta.page_id,
      title: meta.title,
      spaceKey: meta.space,
      version: parseInt(meta.version, 10),
      pulledAt: meta.pulled_at,
      digest: meta.digest,
    },
    markdown: body,
  };
}

function digestOf(storage) {
  return "sha256:" + crypto.createHash("sha256").update(String(storage), "utf8").digest("hex").slice(0, 16);
}

function createStore(dir) {
  function mdPath(pageId) {
    return path.join(dir, pageId + ".md");
  }
  function macroPath(pageId) {
    return path.join(dir, "." + pageId + ".macros.json");
  }

  /* Writes the Markdown file and its sidecar. Returns the paths so the
   * caller can tell the person where to look. */
  function save(page) {
    fs.mkdirSync(dir, { recursive: true });

    const meta = {
      pageId: page.pageId,
      title: page.title,
      spaceKey: page.spaceKey,
      version: page.version,
      pulledAt: page.pulledAt || new Date().toISOString(),
      digest: page.digest || digestOf(page.markdown),
    };

    fs.writeFileSync(mdPath(page.pageId), formatHeader(meta) + page.markdown, "utf8");
    fs.writeFileSync(
      macroPath(page.pageId),
      JSON.stringify({ pageId: page.pageId, macros: page.macros || [] }, null, 2),
      "utf8"
    );

    return { markdownFile: mdPath(page.pageId), sidecarFile: macroPath(page.pageId), meta: meta };
  }

  /* Returns null when the page was never pulled, so callers can say so
   * rather than failing on a missing file. */
  function load(pageId) {
    const file = mdPath(pageId);
    if (!fs.existsSync(file)) return null;

    const parsed = parseHeader(fs.readFileSync(file, "utf8"));
    if (!parsed.meta) {
      throw new Error(
        file + " has no amber header.\n" +
        "It was either not produced by amber, or the header was removed. Pull the page again."
      );
    }

    const sidecar = macroPath(pageId);
    const macros = fs.existsSync(sidecar)
      ? JSON.parse(fs.readFileSync(sidecar, "utf8")).macros || []
      : [];

    return {
      meta: Object.assign({}, parsed.meta, { macros: macros }),
      markdown: parsed.markdown,
      markdownFile: file,
    };
  }

  function list() {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(function (f) { return /^\d+\.md$/.test(f); })
      .map(function (f) { return f.replace(/\.md$/, ""); });
  }

  return { save: save, load: load, list: list, dir: dir, mdPath: mdPath };
}

module.exports = { createStore, parseHeader, formatHeader, digestOf };
