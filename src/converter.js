/* Confluence storage format  <->  Markdown
 *
 * Design rule: anything Markdown cannot express is NEVER reconstructed.
 * It is lifted out verbatim before parsing and put back byte-for-byte on
 * the way out. Macros, layouts, task lists, attachments, status lozenges,
 * user mentions and any other ac:/ri: markup survive a full round trip
 * even though the editor only ever shows Markdown.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CFConvert = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. Opaque region extraction
   * ------------------------------------------------------------------ */

  // Tokens must be unlikely to occur in prose, stable across editing, and
  // legible enough that a human moving one knows what they are moving.
  var TOKEN_RE = /⟦([A-Za-z0-9._-]+)#(\d+)⟧/g;

  function makeToken(label, n) {
    return "⟦" + label + "#" + n + "⟧";
  }

  // Names whose subtrees are lifted out whole.
  function isOpaqueTag(name) {
    return /^(ac|ri):/i.test(name);
  }

  /* Labels are cosmetic -- they only help a human recognise what they are
   * moving. Token identity is label + counter, so the label must stay
   * inside the character class TOKEN_RE matches. */
  function sanitizeLabel(s) {
    var out = String(s).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return out || "block";
  }

  function macroLabel(tagName, raw) {
    if (/^ac:structured-macro$/i.test(tagName)) {
      var m = /\bac:name\s*=\s*"([^"]*)"/i.exec(raw);
      return m ? "macro." + sanitizeLabel(m[1]) : "macro";
    }
    return sanitizeLabel(
      tagName.replace(/^ac:/i, "").replace(/^ri:/i, "ri.")
    );
  }

  /* Scan raw storage XHTML, replacing every top-level ac:/ri: subtree with
   * a token. Nested ac: inside an extracted subtree rides along untouched,
   * which is exactly what we want -- the whole macro is one opaque unit. */
  function extractOpaque(storage) {
    var out = "";
    var macros = [];
    var counters = Object.create(null);
    var i = 0;
    var n = storage.length;

    while (i < n) {
      var lt = storage.indexOf("<", i);
      if (lt === -1) {
        out += storage.slice(i);
        break;
      }
      out += storage.slice(i, lt);

      var tag = readTag(storage, lt);
      if (!tag) {
        // A bare "<" in text. Emit and move on.
        out += "<";
        i = lt + 1;
        continue;
      }

      if (tag.closing || !isOpaqueTag(tag.name)) {
        out += storage.slice(lt, tag.end);
        i = tag.end;
        continue;
      }

      var region;
      if (tag.selfClosing) {
        region = storage.slice(lt, tag.end);
        i = tag.end;
      } else {
        var close = findMatchingClose(storage, tag.end, tag.name);
        if (close === -1) {
          // Unbalanced. Treat the open tag as literal rather than eating
          // the rest of the document.
          out += storage.slice(lt, tag.end);
          i = tag.end;
          continue;
        }
        region = storage.slice(lt, close);
        i = close;
      }

      var label = macroLabel(tag.name, region);
      counters[label] = (counters[label] || 0) + 1;
      var token = makeToken(label, counters[label]);
      macros.push({ token: token, xml: region, label: label });
      out += token;
    }

    return { text: out, macros: macros };
  }

  /* Read a tag starting at position `lt` (which must be "<").
   * Quote-aware so that attribute values containing ">" do not truncate. */
  function readTag(s, lt) {
    if (s[lt] !== "<") return null;
    var j = lt + 1;
    var closing = false;
    if (s[j] === "/") {
      closing = true;
      j++;
    }
    if (s[j] === "!" || s[j] === "?") {
      // Comment, CDATA or PI -- skip to its real end.
      if (s.startsWith("<!--", lt)) {
        var ce = s.indexOf("-->", lt);
        return {
          name: "!--",
          closing: false,
          selfClosing: true,
          end: ce === -1 ? s.length : ce + 3,
        };
      }
      if (s.startsWith("<![CDATA[", lt)) {
        var de = s.indexOf("]]>", lt);
        return {
          name: "![CDATA[",
          closing: false,
          selfClosing: true,
          end: de === -1 ? s.length : de + 3,
        };
      }
      var pe = s.indexOf(">", lt);
      return {
        name: "!",
        closing: false,
        selfClosing: true,
        end: pe === -1 ? s.length : pe + 1,
      };
    }

    var start = j;
    while (j < s.length && /[A-Za-z0-9:._-]/.test(s[j])) j++;
    if (j === start) return null;
    var name = s.slice(start, j);

    var q = null;
    while (j < s.length) {
      var c = s[j];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") {
        q = c;
      } else if (c === ">") {
        var selfClosing = s[j - 1] === "/";
        return {
          name: name,
          closing: closing,
          selfClosing: selfClosing,
          end: j + 1,
        };
      }
      j++;
    }
    return null;
  }

  /* Find the index just past the matching close tag for `name`,
   * starting the search at `from` (just past the open tag). */
  function findMatchingClose(s, from, name) {
    var depth = 1;
    var i = from;
    var lower = name.toLowerCase();
    while (i < s.length) {
      var lt = s.indexOf("<", i);
      if (lt === -1) return -1;
      var tag = readTag(s, lt);
      if (!tag) {
        i = lt + 1;
        continue;
      }
      if (tag.name.toLowerCase() === lower && !tag.selfClosing) {
        if (tag.closing) {
          depth--;
          if (depth === 0) return tag.end;
        } else {
          depth++;
        }
      }
      i = tag.end;
    }
    return -1;
  }

  /* ------------------------------------------------------------------ *
   * 2. Minimal XML tree for the remaining (plain XHTML) document
   * ------------------------------------------------------------------ */

  var VOID = { br: 1, hr: 1, img: 1, col: 1, "!--": 1, "!": 1, "![CDATA[": 1 };

  function parseTree(text) {
    var rootNode = { name: "#root", children: [] };
    var stack = [rootNode];
    var i = 0;

    function push(node) {
      stack[stack.length - 1].children.push(node);
    }

    while (i < text.length) {
      var lt = text.indexOf("<", i);
      if (lt === -1) {
        if (i < text.length) push({ name: "#text", text: text.slice(i) });
        break;
      }
      if (lt > i) push({ name: "#text", text: text.slice(i, lt) });

      var tag = readTag(text, lt);
      if (!tag) {
        push({ name: "#text", text: "<" });
        i = lt + 1;
        continue;
      }

      var lname = tag.name.toLowerCase();

      if (lname === "!--" || lname === "!" || lname === "![CDATA[") {
        i = tag.end;
        continue;
      }

      if (tag.closing) {
        for (var k = stack.length - 1; k > 0; k--) {
          if (stack[k].name === lname) {
            stack.length = k;
            break;
          }
        }
        i = tag.end;
        continue;
      }

      var node = {
        name: lname,
        raw: text.slice(lt, tag.end),
        children: [],
      };
      push(node);
      if (!tag.selfClosing && !VOID[lname]) stack.push(node);
      i = tag.end;
    }
    return rootNode;
  }

  function attr(node, key) {
    if (!node.raw) return null;
    var re = new RegExp("\\b" + key + '\\s*=\\s*"([^"]*)"', "i");
    var m = re.exec(node.raw);
    return m ? m[1] : null;
  }

  /* ------------------------------------------------------------------ *
   * 3. Entities
   * ------------------------------------------------------------------ */

  var NAMED = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    nbsp: " ", ndash: "–", mdash: "—",
    hellip: "…", laquo: "«", raquo: "»",
    ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
    middot: "·", bull: "•", deg: "°", times: "×",
    rarr: "→", larr: "←", harr: "↔", copy: "©",
  };

  function decodeEntities(s) {
    return s.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, function (m, body) {
      if (body[0] === "#") {
        var cp =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        if (isFinite(cp) && cp > 0 && cp <= 0x10ffff) {
          try { return String.fromCodePoint(cp); } catch (e) { return m; }
        }
        return m;
      }
      return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : m;
    });
  }

  function encodeEntities(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/ /g, "&nbsp;");
  }

  /* ------------------------------------------------------------------ *
   * 4. storage -> markdown
   * ------------------------------------------------------------------ */

  function isBlank(s) {
    return !s || /^[\s ]*$/.test(s);
  }

  // Escape only what would otherwise be read as Markdown structure.
  function escapeMd(s) {
    return s.replace(/([\\`*_[\]|])/g, "\\$1");
  }

  function inlineToMd(nodes) {
    var out = "";
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      if (nd.name === "#text") {
        out += escapeMd(decodeEntities(nd.text).replace(/\s+/g, " "));
        continue;
      }
      switch (nd.name) {
        case "strong":
        case "b":
          out += "**" + inlineToMd(nd.children).trim() + "**";
          break;
        case "em":
        case "i":
          out += "_" + inlineToMd(nd.children).trim() + "_";
          break;
        case "code":
          out += "`" + textOf(nd) + "`";
          break;
        case "br":
          out += "  \n";
          break;
        case "a":
          var href = attr(nd, "href") || "";
          var label = inlineToMd(nd.children).trim();
          out += href ? "[" + label + "](" + decodeEntities(href) + ")" : label;
          break;
        case "del":
        case "s":
          out += "~~" + inlineToMd(nd.children).trim() + "~~";
          break;
        default:
          out += inlineToMd(nd.children || []);
      }
    }
    return out;
  }

  function textOf(node) {
    if (node.name === "#text") return decodeEntities(node.text);
    var s = "";
    (node.children || []).forEach(function (c) { s += textOf(c); });
    return s;
  }

  /* A table converts to Markdown only when every cell is inline-only.
   * Anything richer (a macro, a nested list, multiple paragraphs) would be
   * silently flattened, so the whole table stays opaque instead. */
  function tableIsSimple(node) {
    var ok = true;
    walk(node, function (nd) {
      if (nd.name === "td" || nd.name === "th") {
        (nd.children || []).forEach(function (c) {
          if (c.name === "#text") return;
          if (/^(strong|b|em|i|code|a|br|del|s|span|p)$/.test(c.name)) {
            // A single wrapping <p> is fine; block content is not.
            if (c.name === "p") {
              var blocks = (c.children || []).filter(function (g) {
                return /^(ul|ol|table|h[1-6]|blockquote|div)$/.test(g.name);
              });
              if (blocks.length) ok = false;
            }
            return;
          }
          ok = false;
        });
      }
    });
    return ok;
  }

  function walk(node, fn) {
    fn(node);
    (node.children || []).forEach(function (c) { walk(c, fn); });
  }

  function rows(node) {
    var rs = [];
    walk(node, function (nd) {
      if (nd.name === "tr") rs.push(nd);
    });
    return rs;
  }

  function cells(tr) {
    return (tr.children || []).filter(function (c) {
      return c.name === "td" || c.name === "th";
    });
  }

  function cellMd(cell) {
    // Unwrap a single <p> so cells do not gain stray blank lines.
    var kids = cell.children || [];
    if (kids.length === 1 && kids[0].name === "p") kids = kids[0].children || [];
    return inlineToMd(kids).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  }

  function listToMd(node, depth, out) {
    var ordered = node.name === "ol";
    var idx = 0;
    (node.children || []).forEach(function (li) {
      if (li.name !== "li") return;
      idx++;
      var inlineKids = [];
      var blockKids = [];
      (li.children || []).forEach(function (c) {
        if (c.name === "ul" || c.name === "ol") blockKids.push(c);
        else inlineKids.push(c);
      });
      var lead = ordered ? idx + ". " : "- ";
      var body = inlineToMd(inlineKids).replace(/\s+/g, " ").trim();
      out.push("  ".repeat(depth) + lead + body);
      blockKids.forEach(function (c) { listToMd(c, depth + 1, out); });
    });
  }

  function blocksToMd(children) {
    var out = [];

    children.forEach(function (nd) {
      if (nd.name === "#text") {
        var t = decodeEntities(nd.text);
        if (!isBlank(t)) out.push(escapeMd(t.trim()));
        return;
      }
      var hm = /^h([1-6])$/.exec(nd.name);
      if (hm) {
        out.push("#".repeat(+hm[1]) + " " + inlineToMd(nd.children).trim());
        return;
      }
      switch (nd.name) {
        case "p": {
          var s = inlineToMd(nd.children).replace(/[ \t]+\n/g, "\n").trim();
          if (!isBlank(s)) out.push(s);
          return;
        }
        case "ul":
        case "ol": {
          var lines = [];
          listToMd(nd, 0, lines);
          if (lines.length) out.push(lines.join("\n"));
          return;
        }
        case "hr":
          out.push("---");
          return;
        case "blockquote": {
          var inner = blocksToMd(nd.children);
          out.push(
            inner
              .join("\n\n")
              .split("\n")
              .map(function (l) { return "> " + l; })
              .join("\n")
          );
          return;
        }
        case "table": {
          if (!tableIsSimple(nd)) {
            out.push("<!-- table kept as-is -->");
            return;
          }
          var rs = rows(nd);
          if (!rs.length) return;
          var head = cells(rs[0]).map(cellMd);
          var lines2 = [
            "| " + head.join(" | ") + " |",
            "|" + head.map(function () { return "---"; }).join("|") + "|",
          ];
          for (var r = 1; r < rs.length; r++) {
            var cs = cells(rs[r]).map(cellMd);
            while (cs.length < head.length) cs.push("");
            lines2.push("| " + cs.join(" | ") + " |");
          }
          out.push(lines2.join("\n"));
          return;
        }
        case "div":
        case "span":
        case "body": {
          var nested = blocksToMd(nd.children);
          nested.forEach(function (x) { out.push(x); });
          return;
        }
        case "pre": {
          out.push("```\n" + textOf(nd).replace(/\n+$/, "") + "\n```");
          return;
        }
        default: {
          var d = blocksToMd(nd.children || []);
          d.forEach(function (x) { out.push(x); });
        }
      }
    });

    return out;
  }

  function toMarkdown(storage) {
    var ex = extractOpaque(String(storage == null ? "" : storage));
    var tree = parseTree(ex.text);
    var md = blocksToMd(tree.children).join("\n\n");
    md = md.replace(/\n{3,}/g, "\n\n").trim();
    return { markdown: md, macros: ex.macros };
  }

  /* ------------------------------------------------------------------ *
   * 5. markdown -> storage
   * ------------------------------------------------------------------ */

  function inlineToStorage(t) {
    // Protect tokens and code spans from entity-encoding and emphasis.
    var slots = [];
    function stash(html) {
      slots.push(html);
      return "\u0000" + (slots.length - 1) + "\u0000";
    }

    t = t.replace(TOKEN_RE, function (m) { return stash(m); });
    t = t.replace(/`([^`]+)`/g, function (_, c) {
      return stash("<code>" + encodeEntities(c) + "</code>");
    });

    // Links before autolinking so link targets are not double-wrapped.
    t = t.replace(/\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g, function (_, label, url) {
      return stash(
        '<a href="' + encodeEntities(url) + '">' + encodeEntities(unescapeMd(label)) + "</a>"
      );
    });

    t = encodeEntities(unescapeMd(t));

    t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, function (m, pre, url) {
      return pre + '<a href="' + url + '">' + url + "</a>";
    });

    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    t = t.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1<em>$2</em>");
    t = t.replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/g, "$1<em>$2</em>");

    t = t.replace(/\u0000(\d+)\u0000/g, function (_, n) { return slots[+n]; });
    return t;
  }

  function unescapeMd(s) {
    return s.replace(/\\([\\`*_[\]|])/g, "$1");
  }

  function splitRow(line) {
    var s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    var cs = [];
    var cur = "";
    for (var i = 0; i < s.length; i++) {
      if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
      if (s[i] === "|") { cs.push(cur); cur = ""; continue; }
      cur += s[i];
    }
    cs.push(cur);
    return cs.map(function (c) { return c.trim(); });
  }

  function isSep(line) {
    return /^\|?[\s:]*-{2,}[-|\s:]*\|?$/.test(line.trim()) && line.indexOf("-") > -1;
  }

  function listBlock(lines, i, depth, ordered) {
    // Collect items at this indent level, recursing for deeper ones.
    var html = ordered ? "<ol>" : "<ul>";
    var re = ordered ? /^(\s*)(\d+)\.\s+(.*)$/ : /^(\s*)[-*]\s+(.*)$/;
    while (i < lines.length) {
      var m = re.exec(lines[i]);
      if (!m) break;
      var indent = m[1].length;
      if (indent < depth) break;
      if (indent > depth) {
        // Deeper list belongs to the previous <li>; handled below.
        break;
      }
      var body = ordered ? m[3] : m[2];
      i++;
      var sub = "";
      // Look ahead for a nested list under this item.
      var deeperUl = /^(\s*)[-*]\s+/.exec(lines[i] || "");
      var deeperOl = /^(\s*)\d+\.\s+/.exec(lines[i] || "");
      var deeper = deeperUl || deeperOl;
      if (deeper && deeper[1].length > depth) {
        var r = listBlock(lines, i, deeper[1].length, !!deeperOl);
        sub = r.html;
        i = r.i;
      }
      html += "<li><p>" + inlineToStorage(body) + "</p>" + sub + "</li>";
    }
    html += ordered ? "</ol>" : "</ul>";
    return { html: html, i: i };
  }

  function toStorage(markdown, macros) {
    var byToken = Object.create(null);
    (macros || []).forEach(function (m) { byToken[m.token] = m.xml; });

    var lines = String(markdown == null ? "" : markdown)
      .replace(/\r\n?/g, "\n")
      .split("\n");
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (/^\s*$/.test(line)) { i++; continue; }

      // A line that is nothing but a token: emit the macro as a block.
      var solo = /^\s*(⟦[A-Za-z0-9._-]+#\d+⟧)\s*$/.exec(line);
      if (solo) {
        out.push(byToken[solo[1]] !== undefined ? byToken[solo[1]] : "");
        i++;
        continue;
      }

      if (/^```/.test(line)) {
        var buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push("<pre>" + encodeEntities(buf.join("\n")) + "</pre>");
        continue;
      }

      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
        var head = splitRow(line);
        i += 2;
        var body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          body.push(splitRow(lines[i]));
          i++;
        }
        var h = "<table><tbody><tr>";
        head.forEach(function (c) { h += "<th>" + inlineToStorage(c) + "</th>"; });
        h += "</tr>";
        body.forEach(function (r) {
          h += "<tr>";
          for (var k = 0; k < head.length; k++) {
            h += "<td>" + inlineToStorage(r[k] != null ? r[k] : "") + "</td>";
          }
          h += "</tr>";
        });
        h += "</tbody></table>";
        out.push(h);
        continue;
      }

      var hm = /^(#{1,6})\s+(.*)$/.exec(line);
      if (hm) {
        var lv = hm[1].length;
        out.push("<h" + lv + ">" + inlineToStorage(hm[2].trim()) + "</h" + lv + ">");
        i++;
        continue;
      }

      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { out.push("<hr />"); i++; continue; }

      if (/^\s*>\s?/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          q.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + toStorage(q.join("\n"), macros) + "</blockquote>");
        continue;
      }

      var ulm = /^(\s*)[-*]\s+/.exec(line);
      var olm = /^(\s*)\d+\.\s+/.exec(line);
      if (ulm || olm) {
        var res = listBlock(lines, i, (ulm || olm)[1].length, !!olm);
        out.push(res.html);
        i = res.i;
        continue;
      }

      var para = [line];
      i++;
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^\s*\|.*\|\s*$/.test(lines[i]) &&
        !/^(#{1,6})\s+/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i]) &&
        !/^```/.test(lines[i]) &&
        !/^\s*⟦[A-Za-z0-9._-]+#\d+⟧\s*$/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      out.push("<p>" + inlineToStorage(para.join(" ")) + "</p>");
    }

    // Any inline token still sitting inside emitted markup resolves here.
    var joined = out.join("");
    joined = joined.replace(TOKEN_RE, function (m) {
      return byToken[m] !== undefined ? byToken[m] : m;
    });
    return joined;
  }

  /* ------------------------------------------------------------------ *
   * 6. Which macros did an edit drop?
   * ------------------------------------------------------------------ */

  function missingMacros(markdown, macros) {
    var present = Object.create(null);
    String(markdown || "").replace(TOKEN_RE, function (m) {
      present[m] = true;
      return m;
    });
    return (macros || []).filter(function (m) { return !present[m.token]; });
  }

  return {
    toMarkdown: toMarkdown,
    toStorage: toStorage,
    missingMacros: missingMacros,
    TOKEN_RE: TOKEN_RE,
    _internal: { extractOpaque: extractOpaque, parseTree: parseTree },
  };
});
