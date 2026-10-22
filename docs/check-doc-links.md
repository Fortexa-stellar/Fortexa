# Doc link checker

`scripts/check-doc-links.mjs` scans `README.md`, `ARCHITECTURE.md`, and
every `docs/*.md` file for local Markdown links and verifies that every
referenced file exists on disk.

## Quick start

```bash
npm run check:docs
```

## What it checks

| Link type | Checked by default | Notes |
|-----------|-------------------|-------|
| Local file links (e.g. `[label](#local-file)`) | ✅ Yes | Exits non-zero if file is missing |
| Reference-style links (`[label]: ./path`) | ✅ Yes | Same file-existence check |
| Anchor-only links (`[label](#heading)`) | ⬜ Skipped | Heading normalisation is renderer-specific |
| External URLs (`https://…`) | ⬜ Opt-in | See below |

## Output

When broken links are found the script prints the **source file**, **line
number**, and **broken target** before exiting with code `1`:

```
  ✗  README.md:7  →  docs/does-not-exist.md  (file not found)

❌  Broken links detected — please fix the links listed above.
```

When all links are valid it exits `0`:

```
✅  All local links are valid.
```

## External URL checking (opt-in)

External checks are disabled by default to keep CI fast and offline-friendly.
Enable them with:

```bash
# Via npm
npm run check:docs:external

# Or directly
node scripts/check-doc-links.mjs --external
```

Each external URL is probed with a `HEAD` request (8 second timeout, follows
redirects). A `405 Method Not Allowed` falls back to a `GET` request.

## CI integration

`.github/workflows/ci.yml` runs this as a blocking quality step:

```yaml
- name: Check documentation links
  run: npm run check:docs
```

The step fails the build automatically when any local link target is missing,
preventing broken evidence links from reaching reviewer-facing docs.

## Requirements

- Node.js ≥ 18 (uses native `fetch` for external checks)
- No additional npm packages required — pure Node.js stdlib only
