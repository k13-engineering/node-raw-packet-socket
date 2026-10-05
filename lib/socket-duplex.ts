import nodeStream from "node:stream";
import type { TErrnoCodes, TErrorWithErrno } from "po6";
import type { TSocket } from "./socket.ts";

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

type TSendQueueEntry = {
  chunk: Uint8Array;
  callback: () => void;
};

type TCreateErrorFromErrno = (args: { operation: string, errno: number }) => TErrorWithErrno;

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

const checkSent = ({
  errno,
  bytesSent,
  chunk,
  createErrorFromErrno
}: {
  errno: number | undefined,
  bytesSent: number | undefined,
  chunk: Uint8Array,
  createErrorFromErrno: TCreateErrorFromErrno
}) => {
  if (errno !== undefined) {
    return createErrorFromErrno({ operation: "sendmsg()", errno });
  }

  if (bytesSent !== chunk.length) {
    return Error(`short write on sendmsg(), sent ${bytesSent} of ${chunk.length} bytes`);
  }

  return undefined;
};

const checkReceived = ({ bytesReceived, msgFlags }: { bytesReceived: number, msgFlags: number }) => {
  if (msgFlags !== 0) {
    return Error(`unexpected msg_flags 0x${msgFlags.toString(16)} from recvmsg()`);
  }

  if (bytesReceived === 0) {
    return Error("interface went down", {
      cause: Error("zero-sized read from recvmsg()")
    });
  }

  return undefined;
};

type TCreateAndStealArgs = {
  socket: TSocket;
  errnoCodes: TErrnoCodes;
  createErrorFromErrno: TCreateErrorFromErrno;
};

// takes ownership of socket and closes it when the duplex is destroyed
// eslint-disable-next-line max-statements
const createAndSteal = ({ socket, errnoCodes, createErrorFromErrno }: TCreateAndStealArgs): nodeStream.Duplex => {

  // assigned below, as it drives the duplex and the socket, which call back into it
  // eslint-disable-next-line prefer-const
  let next: () => void;

  let destroyed = false;
  let mayReadMore = true;

  let socketMaybeHasMore = true;
  let socketMaybeTakesMore = true;

  let sendQueue: TSendQueueEntry[] = [];

  let scheduledNext = nothingScheduled;

  const receiveBuffer = new Uint8Array(64 * 1024);

  const maybeScheduleNext = () => {
    if (scheduledNext.pending()) {
      return;
    }

    scheduledNext = scheduleMicrotask(() => {
      next();
    });
  };

  // eslint-disable-next-line k13-engineering/no-new
  const duplex = new nodeStream.Duplex({
    read: () => {
      mayReadMore = true;
      maybeScheduleNext();
    },

    // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
    write: (chunk: Uint8Array, encoding, callback) => {
      sendQueue = [...sendQueue, { chunk, callback }];
      maybeScheduleNext();
    },

    final: (callback) => {
      callback(Error("cannot end ethernet stream"));
    },

    // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
    destroy: (error, callback) => {
      destroyed = true;
      // closes the poller as well
      socket.close();
      callback(error);
    }
  });

  const poller = socket.poller({
    callback: ({ events }) => {
      socketMaybeHasMore ||= events.readable;
      socketMaybeTakesMore ||= events.writable;

      next();
    },

    onError: ({ error }) => {
      duplex.destroy(error);
    }
  });

  // waits for the socket to become readable or writable if we have to
  const updatePoll = () => {
    poller.update({
      events: {
        readable: mayReadMore && !socketMaybeHasMore,
        writable: sendQueue.length > 0 && !socketMaybeTakesMore,
      }
    });
  };

  const updatePollAndScheduleNext = () => {
    updatePoll();
    maybeScheduleNext();
  };

  const sendNext = () => {
    const { chunk, callback } = sendQueue[0];

    const { errno, bytesSent } = socket.sendmsg({ data: chunk });

    if (errno === errnoCodes.EAGAIN) {
      socketMaybeTakesMore = false;
      updatePollAndScheduleNext();
      return;
    }

    const sendError = checkSent({ errno, bytesSent, chunk, createErrorFromErrno });
    if (sendError !== undefined) {
      duplex.destroy(sendError);
      return;
    }

    sendQueue = sendQueue.slice(1);
    updatePollAndScheduleNext();

    callback();
  };

  const receiveNext = () => {
    const { errno, bytesReceived, msghdr } = socket.recvmsg({ data: receiveBuffer });

    if (errno === errnoCodes.EAGAIN) {
      socketMaybeHasMore = false;
      updatePollAndScheduleNext();
      return;
    }

    if (errno !== undefined) {
      duplex.destroy(createErrorFromErrno({ operation: "recvmsg()", errno }));
      return;
    }

    const receiveError = checkReceived({ bytesReceived, msgFlags: msghdr.msg_flags });
    if (receiveError !== undefined) {
      duplex.destroy(receiveError);
      return;
    }

    updatePollAndScheduleNext();

    // eslint-disable-next-line fp/no-mutating-methods
    mayReadMore = duplex.push(receiveBuffer.slice(0, bytesReceived));
  };

  const maySend = () => {
    return socketMaybeTakesMore && sendQueue.length > 0;
  };

  const mayReceive = () => {
    return socketMaybeHasMore && mayReadMore;
  };

  next = assertNoReentrancy(() => {
    if (destroyed) {
      return;
    }

    if (maySend()) {
      sendNext();
      return;
    }

    if (mayReceive()) {
      receiveNext();
      return;
    }

    updatePoll();
  });

  return duplex;
};

export {
  createAndSteal
};
