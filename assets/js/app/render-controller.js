// Serialize renders, coalesce interactive updates, and discard stale completions.
export function createRenderController({
  getSnapshot,
  onStart = () => {},
  onFrame,
  onError,
}) {
  let pending = null;
  let queued = null;
  let epoch = 0;

  async function render(request = {}) {
    if (!getSnapshot(request)) return null;
    if (pending) {
      if (request.exact) {
        await pending;
        return render(request);
      }
      queued = {
        ...request,
        forceAnalysis: Boolean(request.forceAnalysis || queued?.forceAnalysis),
      };
      return pending;
    }
    const snapshot = getSnapshot(request);
    if (!snapshot) return null;
    const renderEpoch = epoch;
    const task = Promise.resolve().then(async () => {
      onStart(snapshot);
      const started = performance.now();
      try {
        const result = await snapshot.model.render(
          snapshot.canvas,
          snapshot.parameters,
          snapshot.timeSeconds,
          {
            advanceSimulation: Boolean(
              snapshot.advanceSimulation && !request.exact,
            ),
          },
        );
        if (epoch !== renderEpoch) return null;
        return onFrame({
          ...snapshot,
          result,
          renderMilliseconds: performance.now() - started,
        });
      } catch (error) {
        if (epoch === renderEpoch) onError(error);
        return null;
      }
    });
    pending = task;
    try {
      return await task;
    } finally {
      if (pending === task) pending = null;
      if (queued) {
        const next = queued;
        queued = null;
        queueMicrotask(() => render(next));
      }
    }
  }

  function invalidate() {
    epoch += 1;
    queued = null;
  }

  return {
    render,
    invalidate,
    waitForIdle: () => pending || Promise.resolve(),
    getPending: () => pending,
  };
}
