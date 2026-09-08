/**
 * เริ่มเฝ้าดู child ทันทีหลัง spawn เพื่อไม่พลาด `close` ก่อน consumer พร้อมรอผล
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
        rejectExit(new Error(`${label} ไม่สิ้นสุดภายใน ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
}

/** ปลด pipe ของ child ที่หยุดแล้ว เพื่อไม่ให้ Node event loop ค้าง */
export function stopChild(child) {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.kill?.('SIGTERM');
}
