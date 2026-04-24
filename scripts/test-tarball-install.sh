#!/usr/bin/env bash
#
# Tarball-install smoke test: build the package, pack it via `npm pack`,
# install the tarball into a scratch project, and exercise the exports
# users actually rely on. Would have caught the `docs/spec/schemas` gap
# where `loadSchema` threw for any consumer installing from npm.
#
# Run locally: `bash scripts/test-tarball-install.sh`
# Run in CI: wired into `.github/workflows/ci.yml` tarball-smoke job.

set -euo pipefail

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo "[tarball-smoke] building..."
bun run build

echo "[tarball-smoke] packing..."
TARBALL=$(npm pack --json | sed -n 's/.*"filename": *"\([^"]*\)".*/\1/p' | head -1)
if [ -z "${TARBALL:-}" ]; then
  echo "ERROR: npm pack did not produce a tarball"
  exit 1
fi

# Verify required paths are in the tarball before even trying to install.
CONTENTS=$(tar -tzf "$TARBALL")
for REQUIRED in "package/dist/node/index.js" "package/dist/core/index.js" "package/docs/spec/schemas"; do
  if ! echo "$CONTENTS" | grep -q "^$REQUIRED"; then
    echo "ERROR: tarball missing required path: $REQUIRED"
    exit 1
  fi
done
echo "[tarball-smoke] tarball contents OK"

# Install into a scratch dir and import.
cp "$TARBALL" "$TMPDIR/"
cd "$TMPDIR"
npm init -y > /dev/null
npm install "./$TARBALL" --no-package-lock > /dev/null

node --input-type=module <<'EOF'
import { createAgent, loadSchema } from '@researchcomputer/agents-sdk';
if (typeof createAgent !== 'function') {
  console.error('createAgent is not a function');
  process.exit(1);
}
// Use a schema we know is shipped. 'session' is in docs/spec/schemas/
// as session.v1.schema.json.
const s = await loadSchema('session', '1');
if (!s || typeof s !== 'object') {
  console.error('loadSchema returned falsy');
  process.exit(1);
}
console.log('tarball import + loadSchema OK');
EOF

echo "[tarball-smoke] PASSED"
