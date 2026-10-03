# Help test amber-confluence on your Confluence

Thank you for trying this. It takes about 20 minutes, and it never touches a page you
care about: the only page you edit is a copy you make yourself.

What we need most is variety: different Confluence versions, different companies'
setups, and computers other than a Mac. If something fails, that is a useful result.

## Before you start

- **Ask if you need to.** If your company has rules about tools that use the
  Confluence API, check them first. The safe steps below only read, except for the
  copy you make in your personal space.
- **Node 18 or newer.** `node --version` tells you. Install from nodejs.org if needed.
- **Your Confluence version.** Bottom of any page, or Help → About Confluence.

```bash
npm install -g amber-confluence
```

Create `~/.config/amber/config.toml` (on Windows: `%USERPROFILE%\.config\amber\config.toml`):

```toml
[confluence]
url  = "https://your-wiki.example.com"
user = "you@example.com"     # leave out if you use a personal access token
```

Store your credential once. On Confluence Data Center 7.9 and newer, create a personal
access token in your profile settings; older versions use your password.

```bash
# macOS
security add-generic-password -s amber-confluence-token -a 'you@example.com' -w

# Linux
secret-tool store --label=amber service amber-confluence-token account you@example.com

# Windows, or anywhere, for this terminal session only
set AMBER_CONFLUENCE_TOKEN=...           (cmd)
$env:AMBER_CONFLUENCE_TOKEN="..."        (PowerShell)
```

## Step 1 — the doctor, read only

Pick any page you can read, ideally one with tables, panels and macros. Copy its id from
the URL, or paste the whole URL.

```bash
amber confluence doctor <page>
```

It reads, never writes. Note every line that is not a `✓`.

## Step 2 — make a copy to play with

In Confluence, open a **complex** real page — the more tables, lists inside tables,
panels, status labels and layouts, the better. Use `•••` → **Copy**, and put the copy in
**your personal space**. From now on you only touch the copy.

## Step 3 — the round trip

Run each line and write down what happened.

| # | Do this | Expected |
|---|---|---|
| 3.1 | `amber confluence pull <copy>` | A `.md` file is written; markers like `⟦macro.info#1⟧` stand in for macros |
| 3.2 | `amber confluence push <copy>` without editing | `Nothing to publish` — no new version in the page history |
| 3.3 | Edit **one** sentence in the `.md` file | — |
| 3.4 | `amber confluence diff <copy>` | Shows only your sentence |
| 3.5 | `amber confluence push <copy>` | Publishes, version goes up by one |
| 3.6 | In the browser: page `•••` → **Page History**, tick the last two versions → **Compare** | **Only your sentence** is highlighted. Anything else highlighted is a bug — please screenshot it |
| 3.7 | Look at the page itself | Tables, panels, colours and line breaks look as before |

## Step 4 — the safety nets

| # | Do this | Expected |
|---|---|---|
| 4.1 | `pull` the copy. Then edit the copy **in the browser** and save. Then edit the `.md` and `push` | Refuses: *the page changed after you pulled it*, and names who changed it |
| 4.2 | `pull` again. Delete one `⟦…⟧` marker from the `.md` and `push` | Refuses, and names the block that would disappear |

## Step 5 — with an agent (optional)

If you use Claude or another MCP client, add the server (README → *Use it from an
agent*) and ask it to change one sentence on your copy. Check Page History → Compare
the same way.

## Send the result

Open an issue with the **Compatibility report** template:
<https://github.com/amber-tools/amber-confluence/issues/new?template=compatibility-report.md>

Paste the output of:

```bash
amber confluence doctor --share <copy>
```

It contains no host name, no account and no page content. Please do not paste page
text or screenshots of real pages — screenshots of your own copy are fine if they show
nothing confidential.
