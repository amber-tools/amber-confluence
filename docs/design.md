# Design notes

Why the tool behaves the way it does. Written before the code, kept in step with it.

## The problem

Atlassian's connector and MCP server talk to Confluence Cloud. Self-hosted Server and
Data Center instances have no equivalent, which leaves a large part of the corporate
world without programmatic access to its own documentation.

Editing the storage format by hand is not an answer. A naive edit destroys macros,
anchors and nested layouts, and the damage is usually noticed days later by someone
who did not make it.

## The rule that shapes everything

**Anything Markdown cannot express is never reconstructed.**

It is lifted out verbatim before parsing and put back byte for byte on the way out.
The conversion never sees inside it, so it cannot corrupt it.

In the Markdown, a visible marker stands in its place:

```
⟦macro.warning#1⟧
⟦macro.status#2⟧
```

A marker is visible rather than hidden on purpose. A reader who can see it can move
it, copy it or delete it deliberately. A hidden anchor gets lost silently, and the
loss surfaces on the published page.

Macros, layout structures, task lists, attachments, status lozenges, user mentions and
any other `ac:` or `ri:` markup make the full round trip.

## Two refusals

The tool writes into a shared wiki, so the dangerous operations are the silent ones.

**Publishing over a page that moved on.** If the server holds a newer version than the
local copy came from, someone edited the page in between. Publishing replaces their
work with text that never contained it. The push stops and names the version, the
person and the time.

**Publishing without a marker that was there.** A missing marker means the macro,
panel or attachment it stood for disappears from the page. The push stops and names
every block that went.

Both exit with status 2, so a script can tell a refusal from a failure, and both are
overridable with `--force` — deliberately, never accidentally.

## Credentials

Personal access tokens exist from Data Center 7.9 onwards. A large share of
self-hosted instances are older, so username and password over Basic auth is a
first-class path rather than a fallback. Instances that serve pages anonymously need
no credential at all.

Secrets never live in the configuration file. The file says where the instance is and
who is connecting; the secret comes from the OS keychain or, for a single command,
from the environment. A configuration file containing a token is refused with an
explanation instead of being quietly accepted, because such a file ends up in a
backup, a screen share or a repository.

Tokens are never logged, never echoed in errors, and never written to disk.

## A page on disk

An ordinary Markdown file with a short header:

```yaml
---
amber: confluence
page_id: 100000001
title: Onboarding
space: DEMO
version: 12
pulled_at: 2026-09-20T10:14:00Z
digest: sha256:9f2ac41b8e5d7a03
---
```

The header makes the file self-describing, so moving it, copying it or committing it
to git keeps it usable. The opaque blocks live in a sidecar file instead: they are raw
markup, sometimes kilobytes of it, and a header no one can read is a header people
delete.

## Shape of the code

```
src/converter.js   storage format <-> Markdown, the round-trip rule
src/client.js      one REST layer for both entry points
src/config.js      configuration and credentials
src/store.js       local copies of pages
bin/amber.js       command line
bin/mcp-server.js  MCP server
```

The CLI and the MCP server share the transport, the configuration, the storage layout
and the refusals. An agent and a person get identical behaviour, and a fix lands in
both at once.

No runtime dependencies. The configuration reader covers the subset of TOML the file
needs and nothing else.

## Testing

Tests run without a network and without a Confluence instance: the HTTP layer takes an
injected `fetch`, and the MCP suite drives a real server process over stdio.

Fixtures are synthetic and stay that way. The round-trip fixture is as structurally
complex as a real page — warning panel, status lozenges inside table cells, nested
lists, attachment, table of contents, expand block with formatted text — because that
is where naive converters break.

Non-ASCII content is covered explicitly. Data Center is mostly run by companies that
do not write in English, so Cyrillic, umlauts and CJK have their own test rather than
appearing by accident.

## Scope of 0.1

In: the converter, four commands, the MCP server, configuration, tests, documentation.

Deliberately out: pulling page trees, uploading attachments, creating pages, a browser
editor, Confluence Cloud.

## What counts as success

Not stars. Someone with a self-hosted Confluence installs the tool, pulls their own
page, pushes it back, and finds that nothing broke.
