'use strict';

// Kill a spawned child and everything it started. On Windows that means
// `taskkill /T` (kill the whole tree); elsewhere we signal the process group
// created by spawning `detached: true`, then hard-kill after a short grace.
//
// Uses child_process only for the Windows taskkill path. No vscode.

const { spawn } = require('child_process');

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// Recommended spawn options so killTree can take the whole group down.
function spawnGroupOpts(platform) {
  const plat = platform || process.platform;
  // On POSIX, detached makes the child a group leader (kill -pid).
  // On Windows we rely on taskkill /T instead.
  return { detached: plat !== 'win32' };
}

function killTree(child, opts) {
  opts = opts || {};
  const graceMs = opts.graceMs == null ? 1500 : opts.graceMs;
  if (!child || child.pid == null) return Promise.resolve(false);
  const pid = child.pid;
  const plat = opts.platform || process.platform;

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };

    if (plat === 'win32') {
      try {
        const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        tk.on('close', () => finish(!isAlive(pid)));
        tk.on('error', () => {
          try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
          finish(!isAlive(pid));
        });
      } catch (e) {
        try { child.kill('SIGKILL'); } catch (e2) { /* ignore */ }
        finish(!isAlive(pid));
      }
      return;
    }

    // POSIX: signal the group, then hard-kill.
    const signalGroup = (sig) => {
      try { process.kill(-pid, sig); return true; } catch (e) { /* fall through */ }
      try { child.kill(sig); return true; } catch (e) { return false; }
    };
    signalGroup('SIGTERM');
    const timer = setTimeout(() => {
      signalGroup('SIGKILL');
      setTimeout(() => finish(!isAlive(pid)), 100);
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      // group may still hold orphans; sweep once more
      signalGroup('SIGKILL');
      finish(true);
    });
  });
}

module.exports = { killTree, isAlive, spawnGroupOpts };
