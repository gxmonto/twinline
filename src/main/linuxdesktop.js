'use strict';
/**
 * Linux menu hygiene for people who move from the AppImage to the .deb/.rpm.
 *
 * Running an AppImage once on Fedora/Ubuntu usually makes the desktop's
 * AppImage helper (GNOME Software, Gear Lever, AppImageLauncher) write a
 * launcher for it into ~/.local/share/applications. Installing the package
 * later adds /usr/share/applications/twinline.desktop, but the menu merges
 * both under one name and prefers the per-user one — which, once the AppImage
 * is deleted, points at nothing. Mike hit exactly this: the menu "opened" an
 * AppImage he had removed. The same stale id can also be the registered
 * handler for sip:/tel: links in ~/.config/mimeapps.list.
 *
 * So, when the installed package starts, remove only launchers that (a) are
 * ours by name and (b) run a file that no longer exists, and repoint any link
 * handler that used them to the package's launcher. Nothing is touched while
 * the AppImage still exists — someone may genuinely want both.
 */

const fs = require('fs');
const path = require('path');

const PACKAGE_DESKTOP_ID = 'twinline.desktop';

/** Path of the program a .desktop Exec= line runs, unquoted, without arguments. */
function execTarget(desktopText) {
  const m = /^Exec=(.*)$/m.exec(desktopText);
  if (!m) return null;
  let exec = m[1].trim();
  // AppImage helpers often wrap the path: `"/home/x/App.AppImage" %U` or
  // `env FOO=1 /home/x/App.AppImage`.
  exec = exec.replace(/^env\s+(\S+=\S*\s+)*/, '');
  const quoted = /^"([^"]+)"/.exec(exec);
  return quoted ? quoted[1] : exec.split(/\s+/)[0];
}

function mentionsTwinLine(desktopText) {
  return /^(Name|Exec|X-AppImage-Old-Name|X-GearLever-Name|X-AppImage-Name)=.*twinline/im.test(desktopText);
}

/**
 * @param {string} home  the user's home directory
 * @param {{exists?: (p: string) => boolean}} [deps] for tests
 * @returns {{removed: string[], mimeRepointed: boolean}}
 */
function cleanStaleAppImageEntries(home, { exists = fs.existsSync } = {}) {
  const result = { removed: [], mimeRepointed: false };
  const appsDir = path.join(home, '.local', 'share', 'applications');
  let names = [];
  try { names = fs.readdirSync(appsDir); } catch { return result; }

  const staleIds = [];
  for (const name of names) {
    if (!name.endsWith('.desktop') || name === PACKAGE_DESKTOP_ID) continue;
    const file = path.join(appsDir, name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!mentionsTwinLine(text)) continue;
    const target = execTarget(text);
    if (!target || !/\.appimage$/i.test(target) || exists(target)) continue;
    try {
      fs.unlinkSync(file);
      staleIds.push(name);
      result.removed.push(file);
    } catch { /* not ours to force */ }
  }
  if (!staleIds.length) return result;

  // Link handlers registered against the removed launcher now point at the
  // installed package instead of at nothing.
  const mimeFile = path.join(home, '.config', 'mimeapps.list');
  try {
    const before = fs.readFileSync(mimeFile, 'utf8');
    let after = before;
    for (const id of staleIds) {
      const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      after = after.replace(new RegExp(`(^[^=\\n]+=[^\\n]*?)\\b${esc}`, 'gm'), `$1${PACKAGE_DESKTOP_ID}`);
    }
    if (after !== before) {
      fs.writeFileSync(mimeFile, after);
      result.mimeRepointed = true;
    }
  } catch { /* no mimeapps.list, or unreadable */ }
  return result;
}

module.exports = { cleanStaleAppImageEntries, execTarget, PACKAGE_DESKTOP_ID };
