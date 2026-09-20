/* Talks to the MCP server the way a client does: a real process, real
 * JSON-RPC over stdio. Nothing here reaches Confluence — the calls that
 * would are pointed at a configuration that cannot resolve. */

const path = require("path");
const { spawn } = require("child_process");

let pass = 0, fail = 0;
const fails = [];

function eq(name, got, want) {
  if (got === want) { pass++; return; }
  fail++; fails.push({ name, got, want });
}
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; fails.push({ name, got: detail || "false", want: "true" });
}

const SERVER = path.join(__dirname, "..", "bin", "mcp-server.js");

/* Sends the given requests, resolves once every request carrying an id
 * has been answered. Notifications have no id and expect no reply. */
function talk(requests, env) {
  const expected = requests.filter(function (r) { return r.id !== undefined; }).length;
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, { AMBER_CONFIG: "/nonexistent/amber.toml" }, env || {}),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const replies = [];
    let buffer = "";
    let stderr = "";

    const timer = setTimeout(function () {
      child.kill();
      reject(new Error("server did not answer in time. stderr: " + stderr.slice(0, 400)));
    }, 10000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", function (chunk) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        replies.push(JSON.parse(line));
        if (replies.length === expected) {
          clearTimeout(timer);
          child.kill();
          resolve({ replies: replies, stderr: stderr });
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", function (c) { stderr += c; });

    requests.forEach(function (r) { child.stdin.write(JSON.stringify(r) + "\n"); });
  });
}

(async function () {
  /* ---------------- 1. handshake and tool list ---------------- */
  {
    const { replies, stderr } = await talk([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);

    const init = replies.find(function (r) { return r.id === 1; });
    eq("initialize answers", init.jsonrpc, "2.0");
    eq("server names itself", init.result.serverInfo.name, "amber-confluence");
    eq("protocol echoed", init.result.protocolVersion, "2024-11-05");
    ok("declares tool capability", Boolean(init.result.capabilities.tools), JSON.stringify(init.result.capabilities));

    const list = replies.find(function (r) { return r.id === 2; });
    const names = list.result.tools.map(function (t) { return t.name; }).sort();
    eq("four tools", names.length, 4);
    eq("the expected tools", names.join(","),
       "confluence_pull,confluence_push,confluence_replace,confluence_status");

    list.result.tools.forEach(function (t) {
      ok(t.name + " describes itself", t.description.length > 40, t.description);
      eq(t.name + " has an object schema", t.inputSchema.type, "object");
      ok(t.name + " description is English",
         !/[\u0410-\u044f\u0401\u0451]/.test(t.description), t.description);
    });

    eq("nothing written to stderr", stderr, "");
  }

  /* ---------------- 2. a broken configuration is an answer, not a crash ---------------- */
  {
    const { replies } = await talk([
      { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "confluence_pull", arguments: { page: "123" } } },
    ]);

    const r = replies[0];
    ok("call is answered", Boolean(r.result), JSON.stringify(r));
    eq("marked as an error", r.result.isError, true);
    ok("says what is missing", r.result.content[0].text.includes("No Confluence URL configured"),
       r.result.content[0].text);
  }

  /* ---------------- 3. unknown tools and methods ---------------- */
  {
    const { replies } = await talk([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "confluence_delete_everything", arguments: {} } },
      { jsonrpc: "2.0", id: 2, method: "resources/list" },
    ]);

    const unknownTool = replies.find(function (r) { return r.id === 1; });
    eq("unknown tool is a protocol error", unknownTool.error.code, -32602);
    ok("names the tool", unknownTool.error.message.includes("confluence_delete_everything"),
       unknownTool.error.message);

    const unknownMethod = replies.find(function (r) { return r.id === 2; });
    eq("unsupported method", unknownMethod.error.code, -32601);
  }

  /* ---------------- 4. notifications get no reply ---------------- */
  {
    const { replies } = await talk([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 9, method: "tools/list" },
    ]);

    eq("only the request with an id was answered", replies.length, 1);
    eq("and it is the right one", replies[0].id, 9);
  }

  /* ---------------- report ---------------- */
  console.log("");
  if (fails.length) {
    console.log("FAILURES (" + fails.length + "):\n");
    fails.forEach(function (f) {
      console.log("  ✗ " + f.name);
      console.log("      got:  " + JSON.stringify(f.got).slice(0, 300));
      console.log("      want: " + JSON.stringify(f.want).slice(0, 300));
    });
    console.log("");
  }
  console.log("passed " + pass + ", failed " + fail);
  process.exit(fail ? 1 : 0);
})();
