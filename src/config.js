/* Configuration and credentials for amber-confluence.
 *
 * One rule shapes this file: secrets never live in the config file.
 * The file describes where the instance is and how to authenticate;
 * the secret itself comes from the OS keychain or the environment.
 * A config file containing a token or a password is rejected with an
 * explanation rather than quietly accepted, because a file like that
 * ends up in a backup, a screen share or a git repository.
 *
 * Sources, later overrides earlier:
 *   1. built-in defaults
 *   2. ~/.config/amber/config.toml   (or $AMBER_CONFIG)
 *   3. environment variables
 *
 * Authentication has two paths on purpose. Personal Access Tokens only
 * exist from Confluence Data Center 7.9 onwards, and a large share of
 * self-hosted instances are older than that, so username and password
 * over Basic auth stays a first-class option rather than a fallback.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "amber", "config.toml");
const DEFAULT_KEYCHAIN_SERVICE = "amber-confluence";

/* ------------------------------------------------------------------ *
 * A deliberately small TOML reader
 *
 * Supports exactly what the config file needs: comments, [sections],
 * and key = "string" | integer | boolean. Anything else is an error
 * naming the line, which is friendlier than a dependency that accepts
 * constructs this file will never use.
 * ------------------------------------------------------------------ */

function parseToml(text, source) {
  const out = {};
  let table = out;

  text.split(/\r?\n/).forEach(function (raw, i) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) return;

    const section = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (section) {
      table = out[section[1]] || (out[section[1]] = {});
      return;
    }

    const pair = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!pair) {
      throw new Error(source + ":" + (i + 1) + ": cannot read this line: " + raw.trim());
    }

    const key = pair[1];
    const rawValue = pair[2].trim();
    let value;

    if (/^"([^"\\]*)"$/.test(rawValue)) value = rawValue.slice(1, -1);
    else if (/^'([^'\\]*)'$/.test(rawValue)) value = rawValue.slice(1, -1);
    else if (/^(true|false)$/.test(rawValue)) value = rawValue === "true";
    else if (/^-?\d+$/.test(rawValue)) value = parseInt(rawValue, 10);
    else {
      throw new Error(
        source + ":" + (i + 1) + ': value must be quoted, a number or a boolean: ' + rawValue
      );
    }

    table[key] = value;
  });

  return out;
}

/* ------------------------------------------------------------------ *
 * Secrets
 * ------------------------------------------------------------------ */

const SECRET_KEYS = ["token", "password", "pass", "secret", "api_token", "pat"];

function rejectSecretsInFile(parsed, file) {
  const found = [];
  Object.keys(parsed).forEach(function (k) {
    const v = parsed[k];
    if (v && typeof v === "object") {
      Object.keys(v).forEach(function (kk) {
        if (SECRET_KEYS.indexOf(kk.toLowerCase()) !== -1) found.push(k + "." + kk);
      });
    } else if (SECRET_KEYS.indexOf(k.toLowerCase()) !== -1) {
      found.push(k);
    }
  });

  if (found.length) {
    throw new Error(
      "Remove " + found.join(", ") + " from " + file + ".\n" +
      "Secrets are never read from the config file, so this value would not be used anyway.\n" +
      "Store it in the OS keychain instead:\n" +
      "  " + keychainHint(DEFAULT_KEYCHAIN_SERVICE, "<account>") + "\n" +
      "or pass it through AMBER_CONFLUENCE_TOKEN / AMBER_CONFLUENCE_PASSWORD for one command."
    );
  }
}

function keychainHint(service, account) {
  if (process.platform === "darwin") {
    return "security add-generic-password -s " + service + " -a '" + account + "' -w";
  }
  return "secret-tool store --label='" + service + "' service " + service + " account '" + account + "'";
}

/* Reads a secret from the OS keychain. Returns null when there is none,
 * so the caller can decide whether that is fatal. The value is never
 * logged and never written anywhere. */
function keychainSecret(service, account) {
  try {
    if (process.platform === "darwin") {
      const args = ["find-generic-password", "-s", service, "-w"];
      if (account) args.splice(2, 0, "-a", account);
      return execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .replace(/\n$/, "");
    }
    return execFileSync(
      "secret-tool",
      ["lookup", "service", service, "account", account || ""],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim() || null;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

function readConfigFile(file) {
  if (!fs.existsSync(file)) return {};
  return parseToml(fs.readFileSync(file, "utf8"), file);
}

function normalizeBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

/* env is injected so tests do not have to mutate process.env */
function load(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const file = opts.file || env.AMBER_CONFIG || DEFAULT_CONFIG_PATH;

  const parsed = opts.parsed || readConfigFile(file);
  /* The check belongs here rather than in the file reader: a caller that
   * supplies a parsed config must not be able to skip it. */
  rejectSecretsInFile(parsed, file);
  const cf = parsed.confluence || {};

  const baseUrl = normalizeBase(env.AMBER_CONFLUENCE_URL || cf.url);
  const user = env.AMBER_CONFLUENCE_USER || cf.user || "";
  const service = env.AMBER_KEYCHAIN_SERVICE || cf.keychain_service || DEFAULT_KEYCHAIN_SERVICE;

  const pagesDir = env.AMBER_PAGES_DIR || cf.pages_dir || path.join(os.homedir(), "amber", "pages");

  if (!baseUrl) {
    throw new Error(
      "No Confluence URL configured.\n" +
      "Create " + file + ":\n\n" +
      "  [confluence]\n" +
      '  url = "https://confluence.example.com"\n' +
      '  user = "you@example.com"\n\n' +
      "or set AMBER_CONFLUENCE_URL for one command."
    );
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error("Confluence url must start with http:// or https://, got: " + baseUrl);
  }

  const lookup = opts.keychain || keychainSecret;

  /* Token first: on instances that have Personal Access Tokens it is the
   * better credential, and it needs no username. */
  const token = env.AMBER_CONFLUENCE_TOKEN || lookup(service + "-token", user) || "";
  if (token) {
    return session(baseUrl, pagesDir, file, {
      mode: "token",
      header: "Bearer " + token,
      describe: "personal access token",
    });
  }

  const password = env.AMBER_CONFLUENCE_PASSWORD || (user ? lookup(service, user) : null) || "";
  if (user && password) {
    return session(baseUrl, pagesDir, file, {
      mode: "basic",
      header: "Basic " + Buffer.from(user + ":" + password).toString("base64"),
      describe: "username and password",
    });
  }

  if (user && !password) {
    throw new Error(
      "No credential found for " + user + ".\n\n" +
      "On Confluence Data Center 7.9 and newer, create a personal access token and store it:\n" +
      "  " + keychainHint(service + "-token", user) + "\n\n" +
      "On older instances, store the password instead:\n" +
      "  " + keychainHint(service, user) + "\n\n" +
      "For a single command, AMBER_CONFLUENCE_TOKEN or AMBER_CONFLUENCE_PASSWORD also work."
    );
  }

  /* Some instances serve pages anonymously. Sending no Authorization at
   * all is both simpler and safer than sending an empty one. */
  return session(baseUrl, pagesDir, file, {
    mode: "anonymous",
    header: null,
    describe: "anonymous access",
  });
}

function session(baseUrl, pagesDir, file, auth) {
  return {
    baseUrl: baseUrl,
    pagesDir: pagesDir,
    configFile: file,
    auth: auth,
    /* Headers for an API call. Never logged: callers print auth.describe. */
    headers: function (extra) {
      const h = Object.assign({ Accept: "application/json" }, extra || {});
      if (auth.header) h.Authorization = auth.header;
      return h;
    },
  };
}

module.exports = { load, parseToml, keychainSecret, keychainHint, DEFAULT_CONFIG_PATH };
