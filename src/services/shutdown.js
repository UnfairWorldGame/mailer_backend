// Cooperative shutdown signal.
//
// The send engines run unbounded `while` loops in the background, outside any
// request. On a platform that recycles instances routinely (Render redeploys,
// Cloud Run scale-down) the default behaviour — SIGTERM killing the process
// mid-iteration — leaves recipients stuck in `sending` until their claim goes
// stale (5 min) and the campaign lock held until it goes stale (10 min). The
// work is recoverable, but every deploy costs a multi-minute stall.
//
// Both engines poll `isShuttingDown()` at the top of their loop and return
// cleanly, which runs their existing `finally` and releases the campaign/job
// lock immediately. Nothing is force-killed; an in-flight SMTP send always
// finishes and is recorded before the loop exits.

let shuttingDown = false;

export function isShuttingDown() {
  return shuttingDown;
}

export function beginShutdown() {
  shuttingDown = true;
}

// Wait for a set of in-flight job promises, but never longer than `timeoutMs` —
// the platform's grace period before SIGKILL is finite (Render allows ~30s), so
// a hung SMTP socket must not prevent the rest of the shutdown from running.
export async function drain(promises, timeoutMs) {
  if (!promises.length) return true;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const finished = await Promise.race([
      Promise.allSettled(promises).then(() => true),
      deadline,
    ]);
    return finished;
  } finally {
    clearTimeout(timer);
  }
}
