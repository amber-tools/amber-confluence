#!/usr/bin/env node
/* Refuses to let private material into a public repository.
 *
 * This project grew out of a tool written for one company's wiki, so the
 * first version of its tests carried that company's page identifiers,
 * product names and colleagues. None of that belongs here.
 *
 * The rules below are deliberately general: they describe what a public
 * repository may contain, not what any particular employer looks like.
 * A list of an employer's names would itself be private, so it lives
 * outside this repository.
 *
 * Run directly, or as a pre-commit hook against staged content.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

/* Hosts a public repository may legitimately mention. */
const ALLOWED_HOSTS = [
  "example.com", "example.org", "example.net",
  "localhost", "127.0.0.1",
  "github.com", "raw.githubusercontent.com", "www.npmjs.com", "npmjs.com",
  "atlassian.com", "developer.atlassian.com", "confluence.atlassian.com",
  "opensource.org", "modelcontextprotocol.io", "nodejs.org",
  "img.shields.io",
  /* this project's own site */
  "amber.pm",
];

const RULES = [
  {
    name: "NUL byte",
    why: "makes the file binary to diffs, editors and search",
    test: function (text) {
      const i = text.indexOf(String.fromCharCode(0));
      return i === -1 ? null : "at byte " + i;
    },
  },
  {
    name: "e-mail address",
    why: "only example.com addresses belong in a public repository",
    test: function (text) {
      const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
      const bad = m.filter(function (a) { return !/@example\.(com|org|net)$/i.test(a); });
      return bad.length ? bad.join(", ") : null;
    },
  },
  {
    name: "external host",
    why: "a real installation address identifies whose wiki this came from",
    test: function (text) {
      const m = text.match(/https?:\/\/([a-z0-9.-]+)/gi) || [];
      const bad = m
        .map(function (u) { return u.replace(/^https?:\/\//i, "").toLowerCase(); })
        .filter(function (h) {
          return !ALLOWED_HOSTS.some(function (a) { return h === a || h.endsWith("." + a); });
        });
      return bad.length ? Array.from(new Set(bad)).join(", ") : null;
    },
  },
  {
    name: "Cyrillic text",
    why: "fixtures and messages are English; stray Cyrillic usually means copied material",
    test: function (text) {
      /* Written as escapes so this rule does not trip over itself. */
      const m = text.match(/[\u0410-\u044f\u0401\u0451]{3,}/g);
      return m ? Array.from(new Set(m)).slice(0, 5).join(", ") : null;
    },
  },
  {
    name: "long digit run",
    why: "page identifiers from a real instance look exactly like this",
    test: function (text) {
      const m = text.match(/\b\d{9,}\b/g) || [];
      /* 1000000xx are the documented placeholders. */
      const bad = m.filter(function (d) { return !/^1000000\d\d$/.test(d); });
      return bad.length ? Array.from(new Set(bad)).join(", ") : null;
    },
  },
];

const TEXT_FILE = /\.(js|json|md|toml|ya?ml|txt|html|sh)$/i;

function filesToCheck() {
  const staged = process.argv.indexOf("--staged") !== -1;
  const out = execFileSync(
    "git",
    staged ? ["diff", "--cached", "--name-only", "--diff-filter=ACM"] : ["ls-files"],
    { cwd: ROOT, encoding: "utf8" }
  );
  return out.split("\n").filter(function (f) { return f && TEXT_FILE.test(f); });
}

function main() {
  const problems = [];

  filesToCheck().forEach(function (file) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) return;
    const text = fs.readFileSync(full, "utf8");

    RULES.forEach(function (rule) {
      if (rule.appliesTo && !rule.appliesTo(file)) return;
      const found = rule.test(text);
      if (found) problems.push({ file: file, rule: rule, found: found });
    });
  });

  if (!problems.length) {
    console.log("clean: nothing private found in " + filesToCheck().length + " files");
    return 0;
  }

  console.error("Refusing: this content should not be published.\n");
  problems.forEach(function (p) {
    console.error("  " + p.file);
    console.error("    " + p.rule.name + ": " + p.found);
    console.error("    " + p.rule.why + "\n");
  });
  console.error("Replace it with synthetic material. Placeholders used here: example.com,");
  console.error("John Doe, the Lagoon product, page ids 1000000xx.");
  return 1;
}

process.exit(main());
