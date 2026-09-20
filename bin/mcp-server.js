#!/usr/bin/env node
/* MCP server (JSON-RPC over stdio) for self-hosted Confluence.
 *
 * Atlassian's own MCP server talks to Confluence Cloud. Data Center
 * instances have no equivalent, which is the reason this file exists:
 * it gives an agent the same four operations a person gets from the CLI,
 * over the same transport, the same configuration and the same refusals.
 *
 * Tools: confluence_pull, confluence_push, confluence_replace,
 * confluence_status.
 */

"use strict";

const config = require("../src/config.js");
const { createClient } = require("../src/client.js");
const { createStore } = require("../src/store.js");

/* Configuration is read on first use rather than at startup. A server
 * that exits during handshake tells the person nothing; a server that
 * answers the first call with the reason tells them everything. */
let cached = null;
function context() {
  if (!cached) {
    const session = config.load();
    cached = { session: session, client: createClient(session), store: createStore(session.pagesDir) };
  }
  return cached;
}

function markerNote(macros) {
  if (!macros.length) return "No opaque blocks on this page.";
  return (
    macros.length + " opaque block(s): " +
    macros.map(function (m) { return m.token; }).join(" ") + "\n" +
    "These markers stand for markup Markdown cannot express: macros, panels, " +
    "attachments, column boundaries. Move or delete them, but never rewrite " +
    "their contents. They are restored byte for byte on publish."
  );
}

async function toolPull(args) {
  const { client, store } = context();
  const page = await client.pull(args.page);
  store.save(page);

  return [
    page.title + "  (v" + page.version + ", space " + page.spaceKey + ")",
    markerNote(page.macros),
    "",
    "--- MARKDOWN ---",
    page.markdown,
  ].join("\n");
}

async function toolPush(args) {
  const { client, store } = context();
  const pageId = client.pageIdFrom(args.page);
  const local = store.load(pageId);

  if (!local) {
    throw new Error("No local copy of page " + pageId + ". Call confluence_pull first.");
  }
  if (typeof args.markdown !== "string" || !args.markdown.trim()) {
    throw new Error("Nothing to publish: markdown is empty.");
  }

  const result = await client.push(pageId, local.meta, args.markdown, {
    force: args.force,
    message: args.message,
  });

  store.save({
    pageId: pageId,
    title: result.title,
    spaceKey: local.meta.spaceKey,
    version: result.toVersion,
    markdown: args.markdown,
    macros: local.meta.macros,
  });

  const lines = [
    "Published: " + result.title + "  v" + result.fromVersion + " -> v" + result.toVersion,
    result.url,
  ];
  if (result.forcedOverStale) lines.push("Forced over a newer version: another person's edit was overwritten.");
  if (result.removedMacros) lines.push("Forced: " + result.removedMacros + " opaque block(s) removed from the page.");
  return lines.join("\n");
}

/* Pull, substitute, push. The agent never has to hold the whole page. */
async function toolReplace(args) {
  const { client, store } = context();
  const pageId = client.pageIdFrom(args.page);

  const page = await client.pull(pageId);
  store.save(page);

  const oldStr = args.old_string;
  if (typeof oldStr !== "string" || !oldStr) throw new Error("old_string is empty.");

  const first = page.markdown.indexOf(oldStr);
  if (first === -1) {
    throw new Error("old_string does not occur on the page as pulled. Nothing was changed.");
  }
  if (page.markdown.indexOf(oldStr, first + 1) !== -1 && !args.replace_all) {
    throw new Error(
      "old_string occurs more than once. Extend it until it is unique, or pass replace_all: true."
    );
  }

  const updated = args.replace_all
    ? page.markdown.split(oldStr).join(args.new_string)
    : page.markdown.slice(0, first) + args.new_string + page.markdown.slice(first + oldStr.length);

  return toolPush({
    page: pageId,
    markdown: updated,
    message: args.message,
    force: args.force,
  });
}

async function toolStatus(args) {
  const { client, store } = context();
  const ids = args.page ? [client.pageIdFrom(args.page)] : store.list();
  if (!ids.length) return "No pages pulled yet.";

  const lines = [];
  for (const id of ids) {
    const local = store.load(id);
    if (!local) { lines.push(id + "  not pulled"); continue; }
    const s = await client.status(id, local.meta, local.markdown);
    const parts = ["v" + s.localVersion + " local", "v" + s.liveVersion + " on the server"];
    if (s.behind) parts.push("changed by " + (s.lastEditedBy || "someone else"));
    if (s.missingMacros.length) parts.push(s.missingMacros.length + " opaque block(s) missing");
    lines.push(id + "  " + s.title + "\n  " + parts.join(", "));
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Tool declarations
 * ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: "confluence_pull",
    description:
      "Read a Confluence page as Markdown and keep a local copy. Returns the title, " +
      "the version, the opaque block markers and the full Markdown. Accepts a page id " +
      "or any Confluence URL containing one.",
    inputSchema: {
      type: "object",
      properties: { page: { type: "string", description: "page id or page URL" } },
      required: ["page"],
    },
  },
  {
    name: "confluence_push",
    description:
      "Publish Markdown as the new body of the page, replacing it entirely. Refuses when " +
      "the page changed on the server after the pull, and when an opaque block marker is " +
      "missing from the Markdown; force overrides both. message becomes the version comment.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "string" },
        markdown: { type: "string" },
        message: { type: "string", description: "version comment shown in the page history" },
        force: { type: "boolean", description: "publish despite a refusal" },
      },
      required: ["page", "markdown"],
    },
  },
  {
    name: "confluence_replace",
    description:
      "Change one passage: pull the page, replace old_string with new_string, publish. " +
      "Refuses when old_string is absent, or occurs more than once and replace_all is not set.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
        message: { type: "string" },
        force: { type: "boolean" },
      },
      required: ["page", "old_string", "new_string"],
    },
  },
  {
    name: "confluence_status",
    description:
      "Compare local copies with the server: which pages moved on, who changed them, " +
      "and whether any opaque block is missing locally. Reads only. Without page, reports every local copy.",
    inputSchema: {
      type: "object",
      properties: { page: { type: "string" } },
    },
  },
];

const HANDLERS = {
  confluence_pull: toolPull,
  confluence_push: toolPush,
  confluence_replace: toolReplace,
  confluence_status: toolStatus,
};

/* ------------------------------------------------------------------ *
 * JSON-RPC over stdio
 * ------------------------------------------------------------------ */

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }

  const { id, method, params } = msg;

  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: id,
      result: {
        protocolVersion: (params && params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "amber-confluence", version: require("../package.json").version },
      },
    });
  }

  if (method && method.startsWith("notifications/")) return;

  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id: id, result: { tools: TOOLS } });
  }

  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const fn = HANDLERS[name];

    if (!fn) {
      return send({ jsonrpc: "2.0", id: id, error: { code: -32602, message: "Unknown tool: " + name } });
    }

    try {
      const text = await fn(args);
      return send({ jsonrpc: "2.0", id: id, result: { content: [{ type: "text", text: text }], isError: false } });
    } catch (e) {
      /* A refusal is an answer, not a crash: it comes back as tool output
       * so the agent can read it and decide what to do. */
      return send({
        jsonrpc: "2.0",
        id: id,
        result: { content: [{ type: "text", text: String((e && e.message) || e) }], isError: true },
      });
    }
  }

  if (id !== undefined) {
    send({ jsonrpc: "2.0", id: id, error: { code: -32601, message: "Unsupported method: " + method } });
  }
}

/* Only listen when run as a server. Required as a module — by the tests —
 * it must not hold the event loop open. */
if (require.main === module) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", function (chunk) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handleLine(line);
    }
  });
}

module.exports = { TOOLS, HANDLERS };
