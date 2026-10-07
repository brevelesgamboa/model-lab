// Coordinate app-driven frames, internally paced models, and exclusive GPU work.
export function createPlaybackController({
  getModel,
  getEnabled,
  getView,
  isHidden,
  onResume = () => {},
}) {
  let model = null;
  let active = false;
  let suspensions = 0;
  let exclusiveTask = Promise.resolve();

  function sync() {
    const nextModel = getModel();
    const nextActive = Boolean(
      getEnabled() && getView() === "lab" && !isHidden() && suspensions === 0,
    );
    if (model !== nextModel) model?.setClockRunning?.(false);
    const resume = nextActive && (!active || model !== nextModel);
    nextModel?.setClockRunning?.(nextActive);
    model = nextModel;
    active = nextActive;
    if (resume) onResume();
    return active;
  }

  function suspend() {
    suspensions += 1;
    sync();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      suspensions -= 1;
      sync();
    };
  }

  function withExclusiveCompute(operation) {
    const release = suspend();
    const task = exclusiveTask
      .catch(() => undefined)
      .then(async () => {
        await getModel()?.waitForIdle?.();
        return operation();
      })
      .finally(release);
    exclusiveTask = task;
    return task;
  }

  return {
    sync,
    suspend,
    withExclusiveCompute,
    isActive: () => active,
    isSuspended: () => suspensions > 0,
  };
}
