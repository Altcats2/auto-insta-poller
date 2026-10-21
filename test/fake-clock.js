// Advance browser timers deterministically, flushing mutation observers between tasks.
module.exports = function installClock(window) {
  let now = 0, nextId = 0;
  const timers = new Map();
  window.setTimeout = (fn, delay = 0) => {
    const id = ++nextId;
    timers.set(id, { fn, at: now + delay });
    return id;
  };
  window.clearTimeout = id => timers.delete(id);
  return {
    async advance(ms) {
      await Promise.resolve();
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.at;
        timer.fn();
        await Promise.resolve();
      }
      now = target;
      await Promise.resolve();
    },
  };
};
