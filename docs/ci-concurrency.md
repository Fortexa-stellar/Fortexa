# CI concurrency

`.github/workflows/ci.yml` groups runs as `${{ github.workflow }}-${{ github.ref }}` and sets `cancel-in-progress: true`.

A newer push on the same branch cancels the run it replaces, so stale CI does not keep using runners.
