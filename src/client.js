/* Confluence REST client: one transport layer for both entry points.
 *
 * The CLI and the MCP server used to carry a copy of this logic each,
 * with different error texts and slightly different behaviour. One copy
 * means a fix lands in both places at once.
 *
 * fetch is injectable so the tests never touch the network.
 */

"use strict";

const C = require("./converter.js");

const DEFAULT_VERSION_MESSAGE = "Edited as Markdown with amber";

function createClient(session, options) {
  const opts = options || {};
  const doFetch = opts.fetch || globalThis.fetch;
  const base = session.baseUrl;

  async function api(method, urlPath, body) {
    const headers = session.headers(
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            /* Confluence Server rejects non-browser writes without this. */
            "X-Atlassian-Token": "no-check",
          }
    );

    let res;
    try {
      res = await doFetch(base + urlPath, {
        method: method,
        headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(
        "Cannot reach " + new URL(base).host + ": " + e.message + "\n" +
        "Check the URL, your VPN and whether this host is allowed to leave your network."
      );
    }

    const text = await res.text();

    if (res.status === 401) {
      throw new Error(
        session.auth.mode === "anonymous"
          ? "401: this instance does not serve pages anonymously. Configure a credential."
          : "401: Confluence rejected the " + session.auth.describe + "."
      );
    }
    if (res.status === 403) {
      throw new Error(
        "403: access denied. Either the account cannot see this page, or a proxy blocked the request."
      );
    }
    if (res.status === 404) {
      throw new Error("404: no page with this id. Check the page id or the URL you pasted.");
    }
    if (!res.ok) {
      throw new Error(res.status + " " + res.statusText + "\n" + text.slice(0, 800));
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(
        "Confluence returned HTML instead of JSON, which usually means a login page.\n" +
        "Check the credential and whether the instance sits behind single sign-on.\n" +
        text.slice(0, 300)
      );
    }
  }

  /* Accepts a bare id or any Confluence URL carrying one. */
  function pageIdFrom(input) {
    const s = String(input == null ? "" : input).trim();
    const m = s.match(/pageId=(\d+)/) || s.match(/\/pages\/(\d+)/) || s.match(/^(\d+)$/);
    if (!m) {
      throw new Error('Expected a page id or a Confluence URL containing one, got: "' + s + '"');
    }
    return m[1];
  }

  async function fetchPage(pageId) {
    return api("GET", "/rest/api/content/" + encodeURIComponent(pageId) +
      "?expand=body.storage,version,space");
  }

  /* Storage format in, Markdown plus the opaque blocks out. */
  async function pull(pageRef) {
    const pageId = pageIdFrom(pageRef);
    const data = await fetchPage(pageId);
    const storage = data.body && data.body.storage && data.body.storage.value;
    if (typeof storage !== "string") {
      throw new Error("The response carries no body.storage.value; nothing to convert.");
    }

    const converted = C.toMarkdown(storage);
    return {
      pageId: pageId,
      title: data.title,
      spaceKey: data.space && data.space.key,
      version: (data.version && data.version.number) || 0,
      markdown: converted.markdown,
      macros: converted.macros,
      url: base + "/pages/viewpage.action?pageId=" + pageId,
    };
  }

  /* Returns what push would do, without doing it. */
  async function status(pageRef, meta, markdown) {
    const pageId = pageIdFrom(pageRef);
    const live = await api("GET", "/rest/api/content/" + encodeURIComponent(pageId) +
      "?expand=version,space");
    const liveVersion = (live.version && live.version.number) || 0;
    const macros = (meta && meta.macros) || [];

    return {
      pageId: pageId,
      title: live.title,
      localVersion: meta ? meta.version : null,
      liveVersion: liveVersion,
      behind: meta ? liveVersion > meta.version : false,
      lastEditedBy: (live.version && live.version.by && live.version.by.displayName) || null,
      lastEditedAt: (live.version && live.version.when) || null,
      missingMacros: markdown == null ? [] : C.missingMacros(markdown, macros),
    };
  }

  /* Sends Markdown back as storage format.
   *
   * Two refusals, both deliberate and both overridable only on purpose:
   *
   *   - the page moved on since it was pulled. Bumping the live version
   *     and writing local text over it silently discards whatever the
   *     other person wrote.
   *   - an opaque block is no longer present in the Markdown. Publishing
   *     that removes a macro, panel or attachment from the page.
   */
  async function push(pageRef, meta, markdown, pushOptions) {
    const o = pushOptions || {};
    const pageId = pageIdFrom(pageRef);

    if (typeof markdown !== "string" || !markdown.trim()) {
      throw new Error("Nothing to publish: the Markdown is empty.");
    }
    if (!meta) {
      throw new Error("No local copy of page " + pageId + ". Pull it first.");
    }

    const macros = meta.macros || [];
    const lost = C.missingMacros(markdown, macros);
    if (lost.length && !o.force) {
      const e = new Error(
        "Refusing to publish: " + lost.length + " opaque block(s) are gone from the Markdown.\n" +
        lost.map(function (m) { return "  " + m.token + "  (" + (m.label || "") + ")"; }).join("\n") +
        "\n\nPublishing now would remove them from the page. Put the markers back, " +
        "or repeat with force if the removal is intended."
      );
      e.code = "MACROS_MISSING";
      e.missing = lost;
      throw e;
    }

    const live = await api("GET", "/rest/api/content/" + encodeURIComponent(pageId) +
      "?expand=version,space");
    const liveVersion = (live.version && live.version.number) || 0;

    if (meta.version != null && liveVersion > meta.version && !o.force) {
      const who = (live.version && live.version.by && live.version.by.displayName) || "someone else";
      const when = (live.version && live.version.when) || "since you pulled";
      const e = new Error(
        "Refusing to publish: the page changed after you pulled it.\n" +
        "  your copy: v" + meta.version + "\n" +
        "  on the server: v" + liveVersion + ", last edited by " + who + " at " + when + "\n\n" +
        "Pull again and reapply your edit, or repeat with force to overwrite their work."
      );
      e.code = "STALE";
      e.liveVersion = liveVersion;
      throw e;
    }

    const nextVersion = liveVersion + 1;

    await api("PUT", "/rest/api/content/" + encodeURIComponent(pageId), {
      id: String(pageId),
      type: "page",
      title: live.title,
      space: { key: live.space && live.space.key },
      body: { storage: { value: C.toStorage(markdown, macros), representation: "storage" } },
      version: { number: nextVersion, message: o.message || DEFAULT_VERSION_MESSAGE },
    });

    return {
      pageId: pageId,
      title: live.title,
      fromVersion: liveVersion,
      toVersion: nextVersion,
      forcedOverStale: Boolean(o.force && meta.version != null && liveVersion > meta.version),
      removedMacros: lost.length,
      url: base + "/pages/viewpage.action?pageId=" + pageId,
    };
  }

  return { api: api, pull: pull, push: push, status: status, pageIdFrom: pageIdFrom };
}

module.exports = { createClient, DEFAULT_VERSION_MESSAGE };
