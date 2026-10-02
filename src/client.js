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
const { describeTlsError, tlsAdvice } = require("./trust.js");

const DEFAULT_VERSION_MESSAGE = "Edited as Markdown with amber";

function createClient(session, options) {
  const opts = options || {};
  const doFetch = opts.fetch || globalThis.fetch;
  const base = session.baseUrl;

  const timeoutMs = session.timeoutMs || 30000;
  const sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* How long a 429 or 503 asks us to wait. Retry-After is either seconds or
   * an HTTP date; anything unreadable falls back to a short pause, and the
   * wait is capped so a misconfigured proxy cannot stall a command for an
   * hour. */
  function retryDelay(res, attempt) {
    const header = res.headers && res.headers.get ? res.headers.get("retry-after") : null;
    let ms = NaN;
    if (header) {
      ms = /^\d+$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    }
    if (!(ms >= 0)) ms = 1000 * Math.pow(2, attempt);
    return Math.min(ms, 15000);
  }

  async function send(method, url, headers, payload) {
    const init = { method: method, headers: headers, body: payload };
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
      init.signal = AbortSignal.timeout(timeoutMs);
    }
    return doFetch(url, init);
  }

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
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const host = new URL(base).host;

    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await send(method, base + urlPath, headers, payload);
      } catch (e) {
        if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
          throw new Error(
            "No answer from " + host + " within " + Math.round(timeoutMs / 1000) + " s.\n" +
            "The instance may be slow behind its proxy. Raise the limit with timeout = 120 in the config."
          );
        }
        const tlsProblem = describeTlsError(e);
        if (tlsProblem) throw new Error(tlsAdvice(tlsProblem));

        const cause = e && e.cause && (e.cause.code || e.cause.message);
        throw new Error(
          "Cannot reach " + host + (cause ? " (" + cause + ")" : "") + ".\n" +
          "Check the url in your config, your VPN, and whether this host is reachable from this machine."
        );
      }

      /* Rate limits and brief unavailability are worth waiting out; a few
       * attempts, then give up with the reason rather than a status code. */
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        const wait = retryDelay(res, attempt);
        /* Drain the refused response first: an unread body keeps its
         * connection busy, and the retry would queue behind it. */
        try { await res.text(); } catch (e) { /* nothing to drain */ }
        await sleep(wait);
        continue;
      }
      break;
    }

    const text = await res.text();

    /* A redirect to another scheme, host or port drops the Authorization
     * header — fetch does that on purpose, so a credential never follows a
     * redirect to a server it was not meant for. The request then arrives
     * without it and Confluence answers 401, which would read as "your token
     * is wrong" when the token is fine and the url is not. The usual case is
     * http:// in the config for an instance that only serves https://. */
    if (res.redirected && res.url) {
      const from = new URL(base).origin;
      const to = new URL(res.url).origin;
      if (from !== to) {
        const plainPath = urlPath.split("?")[0];
        const cut = res.url.indexOf(plainPath);
        const suggested = cut > 0 ? res.url.slice(0, cut) : to;
        throw new Error(
          base + " redirects to " + to + ", and credentials are not carried across a redirect,\n" +
          "so Confluence received the request without them. Put the address it redirects to in your config:\n\n" +
          '  url = "' + suggested + '"'
        );
      }
    }

    const denied = res.headers && res.headers.get ? res.headers.get("x-authentication-denied-reason") : null;

    if (res.status === 401 && denied && /CAPTCHA/i.test(denied)) {
      throw new Error(
        "Confluence locked this account behind a CAPTCHA after too many failed sign-ins.\n" +
        "Sign in once in the browser and solve it, then run the command again. Your credential is probably fine."
      );
    }
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
    if (res.status === 429 || res.status === 503) {
      throw new Error(
        res.status + ": " + host + " kept asking to slow down after several attempts. Try again in a minute."
      );
    }
    if (!res.ok) {
      throw new Error(res.status + " " + res.statusText + "\n" + text.slice(0, 800));
    }

    /* A write that was redirected may have been replayed against another
     * address, or turned into a read. Say so instead of trusting it. */
    if (res.redirected && method !== "GET") {
      throw new Error(
        "The " + method + " to " + host + " was redirected to " + res.url + ".\n" +
        "Use that address as the url in your config, so writes go straight to it."
      );
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(
        "Confluence returned HTML instead of JSON, which usually means a login page.\n" +
        "If your company signs in through single sign-on, create a personal access token " +
        "in Confluence and use it instead of a password: tokens are not redirected to the login page.\n" +
        text.slice(0, 200)
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
