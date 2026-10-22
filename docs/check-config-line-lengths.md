# Config line-length checker

`scripts/check-config-line-lengths.mjs` flags executable configuration
files whose physical lines exceed **500 characters**. The threshold is
intentionally generous for normal configuration while catching code appended
after hundreds of spaces, outside GitHub's default diff viewport.

## Quick start

```bash
npm run check:config-line-lengths
```

The script uses only the Node.js standard library, so CI can run it before
`npm ci`.

## What it scans

The checker scans these files at the repository root:

| File family | Extensions |
|---|---|
| `next.config.*` | `js`, `cjs`, `mjs`, `ts`, `cts`, `mts` |
| `postcss.config.*` | `js`, `cjs`, `mjs`, `ts`, `cts`, `mts` |
| `eslint.config.*` | `js`, `cjs`, `mjs`, `ts`, `cts`, `mts` |
| `tailwind.config.*` | `js`, `cjs`, `mjs`, `ts`, `cts`, `mts` |
| `vitest.config.*` | `js`, `cjs`, `mjs`, `ts`, `cts`, `mts` |
| `package.json` | — |

## What it excludes

- Lockfiles: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`,
  `pnpm-lock.yaml`, and `bun.lockb`.
- Generated or vendor output: `.git`, `node_modules`, `.next`, `out`,
  `build`, `dist`, and `coverage`. These directories are never traversed.

## Threshold

A physical line may be **at most 500 characters**. A line of 501 characters
fails the check. Line endings are not counted, and both LF and CRLF input are
supported.

## Output

On success:

```
check-config-line-lengths: 6 config file(s) within 500 characters per line.
```

On failure, the script prints only the file and line number, never the line
content, so a hidden payload is not re-published in CI logs:

```
next.config.ts:42
```

The process exits `1` when violations are found, `2` when the scan itself
fails (for example, an unreadable or missing root), and `0` otherwise.

## Fixtures and tests

- `scripts/fixtures/config-line-lengths/normal/next.config.mjs` is a clean
  fixture.
- `scripts/fixtures/config-line-lengths/whitespace-padded/next.config.mjs`
  hides a statement after hundreds of spaces on one physical line.
- `scripts/check-config-line-lengths.test.ts` covers the threshold boundary,
  file selection, exclusions, fixture behavior, CLI exit codes, and ensures
  the failure output contains only the file and line number.

## CI integration

`.github/workflows/ci.yml` runs the check before installing dependencies:

```yaml
- name: Check config line lengths
  run: npm run check:config-line-lengths
```

## Requirements

- Node.js ≥ 18
- No additional npm packages required
