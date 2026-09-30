// Points git at the tracked hooks in .githooks/. Runs from npm's "prepare".
// Never fails the install: CI containers and tarball installs have no usable
// git checkout.
const { execSync } = require('child_process');

try {
  execSync('git config core.hooksPath .githooks', { stdio: 'ignore' });
} catch {
  // not a git checkout, or git is unavailable
}
