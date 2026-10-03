---
name: Compatibility report
about: You ran TESTING.md against your Confluence. Thank you — this is the most useful thing you can send.
title: "Compatibility: Confluence <version>, <OS>"
labels: compatibility
---

**Confluence version:** <!-- e.g. 7.19.21, from Help → About -->
**Operating system:** <!-- macOS 15 / Windows 11 / Ubuntu 24.04 … -->
**Node:** <!-- node --version -->
**Sign-in:** <!-- personal access token / password / anonymous -->
**In front of the wiki:** <!-- nothing / single sign-on / VPN / company certificate / proxy -->

### Doctor

```
paste the output of: amber confluence doctor --share <page>
```

### Round trip on your copy

- [ ] 3.1 pull wrote the file
- [ ] 3.2 push without editing said "Nothing to publish"
- [ ] 3.4 diff showed only my sentence
- [ ] 3.5 push published one new version
- [ ] 3.6 Page History → Compare highlighted **only** my sentence
- [ ] 3.7 the page looks as before

### Safety nets

- [ ] 4.1 refused to publish over an edit made in the browser
- [ ] 4.2 refused when a marker was deleted

### Anything that went wrong

<!-- What you ran, what you expected, what happened. Error text is welcome; page content is not. -->
