/**
 * Start watching the child right after spawn so a `close` is not missed before the consumer is ready to await the result
 */
export function observeChildExit(child, { timeoutMs, label = 'child process' } = {}) {
  return new Promise((resolveExit, rejectExit) => {
    let timeout;
    const onClose = (code) => {
      if (timeout) clearTimeout(timeout);
      resolveExit(code);
    };
    child.once('close', onClose);

    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        child.removeListener('close', onClose);
        child.kill?.('SIGTERM');
        rejectExit(new Error(`${label} did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
}

/** Detach the pipes of a child that has stopped, so the Node event loop does not hang */
export function stopChild(child) {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.kill?.('SIGTERM');
}
