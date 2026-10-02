# Changelog

## 0.2.0

### Fixed — data loss in 0.1.0

Upgrade if you use 0.1.0. Both defects could change a page you published.

- A table with block content in a cell — a list, a nested table, a panel — was
  replaced on publish by the literal text `<!-- table kept as-is -->`, and the
  table was gone.
- A table with a merged cell lost the cells beyond the width of its header row.

Tables that a Markdown table cannot carry exactly are now kept whole, like a macro.

- Text on a page that looked like a marker, for instance a page documenting this
  notation, was turned into a second copy of the macro on publish.

### Changed

- Blocks you did not edit are written back as their original source. Line breaks,
  coloured text, link classes and markup you never touched survive an edit
  elsewhere on the page. Unedited pages now come back byte for byte: 76 of 76 real
  pages from public Confluence 9.2 and 10.2 instances, against 3 of 36 before.
- Pushing a page you did not edit sends nothing and adds no version.

### Added

- `amber confluence doctor [page]`, and `--share` for a report without host,
  account or content.
- The operating system's certificate store is trusted alongside Node's own, and
  `ca_file` names an extra certificate authority. TLS failures say which check
  failed and how to fix it.
- `timeout` in the config, 30 seconds by default.
- Rate limiting (429, 503) is waited out, honouring `Retry-After`.
- Clear messages for a CAPTCHA lock, for `http://` redirecting to `https://`
  (which used to be reported as a rejected token), and for single sign-on pages.
- `diff` handles long pages: sixty thousand lines in milliseconds, where six
  thousand used to take a second and a quarter of a gigabyte.

## 0.1.0

First release.
