/* Which certificates to trust.
 *
 * Self-hosted Confluence almost always sits behind a certificate issued by
 * the company's own authority. Node trusts only its bundled list by default,
 * so out of the box every such instance fails with "fetch failed" — the
 * first and most common reason the tool would simply not work for someone.
 *
 * The company's authority is usually already installed in the operating
 * system, because the browser needs it too. So the system store is trusted
 * in addition to Node's own list, and a file can be named for the cases
 * where it is not installed.
 *
 * Verification is never switched off. A tool that edits a shared wiki has
 * no business teaching people to disable TLS checks.
 */

"use strict";

const fs = require("fs");
const tls = require("tls");

function splitPem(text) {
  return String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
}

/* Returns what was done, so the doctor command can report it. */
function applyTrust(options) {
  const o = options || {};
  const report = { system: false, extraFile: null, extraCount: 0, supported: true };

  if (typeof tls.setDefaultCACertificates !== "function" || typeof tls.getCACertificates !== "function") {
    /* Node older than 22.15 cannot change trust at runtime. NODE_EXTRA_CA_CERTS
     * still works there, and the error message points to it. */
    report.supported = false;
    return report;
  }

  const certs = tls.getCACertificates("default").slice();

  if (o.useSystem !== false) {
    try {
      const system = tls.getCACertificates("system");
      if (system.length) { certs.push.apply(certs, system); report.system = true; }
    } catch (e) {
      /* Some platforms expose no system store; the bundled list remains. */
    }
  }

  if (o.caFile) {
    let text;
    try {
      text = fs.readFileSync(o.caFile, "utf8");
    } catch (e) {
      throw new Error("Cannot read the certificate file " + o.caFile + ": " + e.message);
    }
    const extra = splitPem(text);
    if (!extra.length) {
      throw new Error(o.caFile + " contains no PEM certificate (expected -----BEGIN CERTIFICATE-----).");
    }
    certs.push.apply(certs, extra);
    report.extraFile = o.caFile;
    report.extraCount = extra.length;
  }

  tls.setDefaultCACertificates(Array.from(new Set(certs)));
  return report;
}

/* Turns a TLS failure into the sentence that fixes it. */
const TLS_CODES = {
  SELF_SIGNED_CERT_IN_CHAIN: "the certificate chain ends in an authority this machine does not trust",
  DEPTH_ZERO_SELF_SIGNED_CERT: "the server presents a self-signed certificate",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the certificate was issued by an authority this machine does not trust",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "the certificate was issued by an authority this machine does not trust",
  UNABLE_TO_GET_ISSUER_CERT: "the issuing authority's certificate is missing",
  CERT_HAS_EXPIRED: "the server's certificate has expired",
  CERT_NOT_YET_VALID: "the server's certificate is not valid yet — check this machine's clock",
  ERR_TLS_CERT_ALTNAME_INVALID: "the certificate was issued for a different host name",
};

function describeTlsError(error) {
  let e = error;
  for (let depth = 0; e && depth < 5; depth++) {
    const code = e.code;
    if (code && TLS_CODES[code]) return { code: code, reason: TLS_CODES[code] };
    e = e.cause;
  }
  return null;
}

function tlsAdvice(found) {
  const lines = ["TLS check failed: " + found.reason + " (" + found.code + ")."];

  if (found.code === "CERT_HAS_EXPIRED" || found.code === "CERT_NOT_YET_VALID" ||
      found.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    lines.push("This is a problem with the server's certificate, not with this tool. Your administrator can fix it.");
    if (found.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
      lines.push("Also check that the url in your config is the exact host name your browser shows.");
    }
    return lines.join("\n");
  }

  lines.push(
    "Your company most likely signs its own certificates. Point the tool at its authority:",
    "",
    "  [confluence]",
    '  ca_file = "/path/to/company-root-ca.pem"',
    "",
    "Your administrator can give you that file, or export it from the browser's certificate viewer.",
    "Do not switch certificate checks off: anyone on the network could then read your credential."
  );
  return lines.join("\n");
}

module.exports = { applyTrust, describeTlsError, tlsAdvice, splitPem };
