type TScheduledMicrotask = {
  pending: () => boolean;
};

const scheduleMicrotask = (callback: () => void): TScheduledMicrotask => {
  let done = false;

  queueMicrotask(() => {
    done = true;
    callback();
  });

  return {
    pending: () => {
      return !done;
    }
  };
};

const nothingScheduled: TScheduledMicrotask = {
  pending: () => {
    return false;
  }
};

// throws if fn is called again while it runs
const assertNoReentrancy = (fn: () => void) => {
  let entered = false;

  return () => {
    if (entered) {
      throw Error("reentered");
    }

    entered = true;

    try {
      fn();
    } finally {
      entered = false;
    }
  };
};

export type {
  TScheduledMicrotask
};

export {
  scheduleMicrotask,
  nothingScheduled,
  assertNoReentrancy
};
