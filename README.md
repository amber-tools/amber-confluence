<h1 align="center">amber-confluence</h1>

<p align="center">
  <b>Edit self-hosted Confluence pages as Markdown.</b><br>
  Macros, layouts and attachments come back untouched.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-10b981" alt="MIT licensed">
  <img src="https://img.shields.io/badge/node-%E2%89%A518-047857" alt="Node 18 or newer">
  <img src="https://img.shields.io/badge/dependencies-none-10b981" alt="No runtime dependencies">
  <img src="https://img.shields.io/badge/Confluence-Server%20%7C%20Data%20Center-047857" alt="Confluence Server and Data Center">
  <img src="https://img.shields.io/badge/MCP-server%20included-10b981" alt="MCP server included">
</p>

---

## What it does

You keep your documentation in a Confluence your company hosts itself. You would like
to edit a page in your own editor, diff it, or let an agent update it — and you cannot,
because Atlassian's tooling only talks to Confluence Cloud.

```console
$ amber confluence pull 100000001        # page becomes Markdown
$ code ~/amber/pages/100000001.md        # edit it however you like
$ amber confluence diff 100000001        # see exactly what will change
$ amber confluence push 100000001        # publish it back
```

Your macros, panels, attachments and layouts survive all of that untouched.

<p align="center">
  <img src="https://raw.githubusercontent.com/amber-tools/amber-confluence/main/docs/roundtrip.svg" alt="A page is pulled to Markdown with markers standing in for macros, edited, and pushed back with the macros restored byte for byte" width="100%">
</p>

---

## Contents

- [Install](#install) · [Set it up](#set-it-up) · [Everyday use](#everyday-use)
- [How macros survive](#how-macros-survive)
- [When it says no](#when-it-says-no)
- [Use it from an agent](#use-it-from-an-agent)
- [What it cannot do yet](#what-it-cannot-do-yet) · [Troubleshooting](#troubleshooting)

---

## Install

```bash
npm install -g amber-confluence
```

Node 18 or newer. Nothing else: no runtime dependencies at all.

## Set it up

**1. Tell it where your Confluence lives.** Create `~/.config/amber/config.toml`:

```toml
[confluence]
url  = "https://wiki.example.com"
user = "you@example.com"          # leave out if you use a token
```

**2. Give it a credential.** Which one depends on your Confluence version:

<table>
<tr><td><b>Data Center 7.9 or newer</b></td><td>Personal access token — Profile → Settings → Personal Access Tokens</td></tr>
<tr><td><b>Anything older</b></td><td>Your usual password. Those versions have no tokens.</td></tr>
<tr><td><b>Public wiki</b></td><td>Nothing. Pages that read anonymously work as they are.</td></tr>
</table>

The credential goes into your keychain, never into the config file:

```bash
# with a token
security add-generic-password -s amber-confluence-token -a 'you@example.com' -w

# with a password
security add-generic-password -s amber-confluence -a 'you@example.com' -w
```

On Linux the same values go into `secret-tool` under the same service names. In a
hurry, `AMBER_CONFLUENCE_TOKEN` or `AMBER_CONFLUENCE_PASSWORD` work for one command.

**3. Try it on a page.** Any page id, or the URL straight from your browser:

```console
$ amber confluence pull https://wiki.example.com/pages/viewpage.action?pageId=100000001
Onboarding  (v12, space DEMO)
/Users/you/amber/pages/100000001.md
3 opaque block(s): ⟦macro.toc#1⟧ ⟦macro.warning#1⟧ ⟦macro.status#1⟧
```

## Everyday use

| Command | What it does |
|---|---|
| `amber confluence pull <page>` | brings the page down as Markdown |
| `amber confluence diff <page>` | shows what publishing would change |
| `amber confluence push <page>` | publishes your edits |
| `amber confluence status [page]` | tells you which copies went out of date |

`<page>` is a page id or any Confluence URL containing one. Add `-m "why"` to `push`
to leave a comment in the page history, and `--json` to any command to get output a
script can read.

A pulled page is ordinary Markdown with a small header, so it opens anywhere and can
live in git:

```markdown
---
amber: confluence
page_id: 100000001
title: Onboarding
space: DEMO
version: 12
pulled_at: 2026-09-20T10:14:00Z
digest: sha256:9f2ac41b8e5d7a03
---

# Onboarding
```

## How macros survive

Confluence stores pages in a markup that Markdown cannot express. Most converters try
to rebuild that markup afterwards, and that is where macros get mangled.

This one never rebuilds anything. Whatever Markdown cannot carry is lifted out before
conversion and put back byte for byte afterwards. In your text you see a marker where
it used to be:

```markdown
⟦macro.warning#1⟧

## Use cases

| # | Case | Status |
|---|---|---|
| UC1 | Sign-up from the landing page | ⟦macro.status#1⟧ |
```

Move a marker, copy it, delete it — all fine. You cannot damage what it stands for,
because its contents never pass through the conversion at all.

## When it says no

Two situations where publishing would quietly destroy something. Both stop, explain
themselves, and exit with status 2 so scripts can tell a refusal from a crash.

**Someone edited the page while you were working.**

```console
$ amber confluence push 100000001
Refusing to publish: the page changed after you pulled it.
  your copy: v12
  on the server: v14, last edited by John Doe at 2026-09-20T09:14:00Z

Pull again and reapply your edit, or repeat with force to overwrite their work.
```

**A marker went missing from your Markdown.** That macro, panel or attachment would
disappear from the page. The message names every block that went.

Both can be overridden with `--force` when you actually mean it.

## Use it from an agent

The MCP server exposes the same four operations, with the same refusals. For Claude
Desktop, Claude Code, or any other MCP client:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "amber-confluence-mcp",
      "env": {
        "AMBER_CONFLUENCE_URL": "https://wiki.example.com",
        "AMBER_CONFLUENCE_USER": "you@example.com"
      }
    }
  }
}
```

| Tool | Use it for |
|---|---|
| `confluence_pull` | read a page as Markdown |
| `confluence_push` | replace the page body |
| `confluence_replace` | change one passage without handling the whole page |
| `confluence_status` | check whether a local copy went stale |

Refusals reach the agent as readable text rather than as errors, so it can pull again
or put a marker back instead of giving up.

## What it cannot do yet

Version 0.1 does one thing properly: a single page, out and back.

Not yet here: pulling a tree of pages, uploading or replacing attachments, creating
new pages. Confluence Cloud is out of scope — Atlassian's own tooling covers it.

Tested against Confluence Server and Data Center 7.x.

## Troubleshooting

<details>
<summary><b>401, and the credential is definitely right</b></summary>

Older instances have no personal access tokens. If yours is below Data Center 7.9,
store the password instead of a token, under the `amber-confluence` service.
</details>

<details>
<summary><b>"Confluence returned HTML instead of JSON"</b></summary>

That is a login page. Usually single sign-on sits in front of the instance, or the
session the credential belongs to has expired.
</details>

<details>
<summary><b>push says a marker is missing, but I did not delete anything</b></summary>

Nested blocks can report this. Pull the page again and push it back unedited: if the
same list appears, the blocks are nested and `--force` is safe here.
</details>

<details>
<summary><b>Where are my files?</b></summary>

`~/amber/pages/<page id>.md`, next to a hidden sidecar holding the opaque blocks.
Change the location with `pages_dir` in the config file.
</details>

## Contributing

Issues and pull requests are welcome. The most useful bug report carries the piece of
Confluence markup that survived a round trip badly — with anything confidential taken
out first.

```bash
npm test          # no network, no Confluence instance needed
```

## License

MIT — see [LICENSE](LICENSE).
