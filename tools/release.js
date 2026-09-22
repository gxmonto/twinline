'use strict';
/**
 * Cut a release: bump the version, fold release-notes.md into CHANGELOG.md,
 * commit, tag, push. GitHub Actions (release.yml) does the building and
 * publishing from there.
 *
 *   npm run release -- patch        1.0.4 -> 1.0.5
 *   npm run release -- minor        1.0.4 -> 1.1.0
 *   npm run release -- major        1.0.4 -> 2.0.0
 *   npm run release -- 1.2.3        exact version
 *   npm run release -- patch --no-push   do everything except push
 *
 * Refuses to run with uncommitted changes or empty release notes, so a
 * release always describes itself and always matches what is in git.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const notesPath = path.join(root, 'release-notes.md');
const changelogPath = path.join(root, 'CHANGELOG.md');

const NOTES_TEMPLATE = '<!-- Describe what changed in the next release. Shown to users in the update banner. -->\n';

function run(cmd) {
  return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function bump(current, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const [maj, min, pat] = current.split('.').map(Number);
  switch (spec) {
    case 'major': return `${maj + 1}.0.0`;
    case 'minor': return `${maj}.${min + 1}.0`;
    case 'patch': return `${maj}.${min}.${pat + 1}`;
    default: return fail(`unknown bump "${spec}" (use patch, minor, major or x.y.z)`);
  }
}

const args = process.argv.slice(2);
const push = !args.includes('--no-push');
const spec = args.find((a) => !a.startsWith('--')) || 'patch';

// Preconditions.
if (run('git status --porcelain')) fail('working tree has uncommitted changes; commit or stash them first');
const branch = run('git rev-parse --abbrev-ref HEAD');
const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : '';
const notesBody = notes.replace(/<!--[\s\S]*?-->/g, '').trim();
if (!notesBody) fail('release-notes.md is empty — write what changed before releasing');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const next = bump(pkg.version, spec);
const tag = `v${next}`;
if (run(`git tag --list ${tag}`)) fail(`tag ${tag} already exists`);

// Version.
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

// Changelog: newest first.
const date = new Date().toISOString().slice(0, 10);
const existing = fs.existsSync(changelogPath)
  ? fs.readFileSync(changelogPath, 'utf8').replace(/^# Changelog\s*/, '')
  : '';
fs.writeFileSync(changelogPath, `# Changelog\n\n## ${next} — ${date}\n\n${notesBody}\n\n${existing}`.trimEnd() + '\n');
// The notes file stays as-is for this release (release.yml reads it for the
// GitHub Release text) and is reset in a follow-up commit below.

run('git add package.json package-lock.json CHANGELOG.md release-notes.md');
run(`git commit -q -m "Release ${tag}"`);
run(`git tag -a ${tag} -m "TwinLine ${next}"`);

fs.writeFileSync(notesPath, NOTES_TEMPLATE);
run('git add release-notes.md');
run('git commit -q -m "Start notes for the next release"');

console.log(`release: ${pkg.version === next ? '' : ''}tagged ${tag} on ${branch}`);
if (push) {
  run(`git push -q origin ${branch}`);
  run(`git push -q origin ${tag}`);
  console.log(`release: pushed. GitHub Actions is now building ${tag}; installed copies will see it once the release is published.`);
} else {
  console.log(`release: not pushed. Run: git push origin ${branch} && git push origin ${tag}`);
}
