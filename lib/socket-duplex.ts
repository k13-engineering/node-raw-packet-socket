import nodeStreamModule from "node:stream";
import po6 from "po6";

const errnoCodes = po6.errnoCodes;

interface IMicrotaskSchedule {
    pending: () => boolean;
    cancel: () => void;
};

const scheduleMicrotask = (callback): IMicrotaskSchedule => {
    let cancelled = false;
    let done = false;

    Promise.resolve().then(() => {
        if (cancelled) {
            return;
        }

        done = true;
        callback();
    });

    const pending = () => {
        return !done && !cancelled;
    };

    const cancel = () => {
        cancelled = true;
    };

    return {
        pending,
        cancel,
    };
};

const createNullSchedule = (): IMicrotaskSchedule => {
    return {
        pending: () => false,
        cancel: () => { },
    };
};

interface ISendQueueEntry {
    chunk: Uint8Array;
    callback: () => void;
};

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

const createAndSteal = ({ socket }: { socket: any }) => {

    let destroyed = false;
    let readRequested = false;
    let mayReadMore = true;

    let socketMaybeHasMore = true;
    let socketMaybeTakesMore = true;

    let sendQueue: ISendQueueEntry[] = [];

    let scheduledNext = createNullSchedule();

    const poller = socket.poller({
        callback: ({ events }) => {

            if (events.readable) {
                socketMaybeHasMore = true;
            }

            if (events.writable) {
                socketMaybeTakesMore = true;
            }

            next();
        }
    });

    const updatePoll = () => {
        let readable = false;
        let writable = false;

        if (sendQueue.length > 0 && !socketMaybeTakesMore) {
            writable = true;
        }

        if (mayReadMore && !socketMaybeHasMore) {
            readable = true;
        }

        poller.update({
            events: {
                readable,
                writable,
            }
        });
    };

    const buffer = Buffer.alloc(64 * 1024);

    const next = assertNoReentrancy(() => {

        if (destroyed) {
            return;
        }

        if (socketMaybeTakesMore && sendQueue.length > 0) {
            const { chunk, callback } = sendQueue[0];

            const { errno, bytesSent } = socket.sendmsg({
                data: chunk,
                msghdr: {

                },
                flags: 0,
            });

            if (errno === errnoCodes.EAGAIN) {
                socketMaybeTakesMore = false;
                updatePoll();
                maybeScheduleNext();
                return;
            }

            if (errno !== errnoCodes.NO_ERROR) {
                const error = po6.createErrorFromErrno({ operation: "sendmsg()", errno });
                duplex.destroy(error);
                return;
            }

            if (bytesSent !== chunk.length) {
                const error = new Error("short-write on sendmsg");
                duplex.destroy(error);
                return;
            }

            sendQueue = sendQueue.slice(1);
            updatePoll();
            maybeScheduleNext();

            callback();
            return;
        }

        if (socketMaybeHasMore && mayReadMore) {

            const { errno, bytesReceived, msghdr } = socket.recvmsg({
                data: buffer,
                msghdr: {

                },
                flags: 0
            });

            if (errno === errnoCodes.EAGAIN) {
                socketMaybeHasMore = false;
                updatePoll();
                maybeScheduleNext();
                return;
            }

            if (errno !== errnoCodes.NO_ERROR) {
                const error = po6.createErrorFromErrno({ operation: "recvmsg()", errno });
                duplex.destroy(error);
                return;
            }

            if (msghdr.msg_flags !== 0) {
                const error = new Error("unexpected msg_flags on sendmsg");
                duplex.destroy(error);
                return;
            }

            if (bytesReceived === 0) {
                duplex.destroy(Error("zero-sized recvmsg, interface probably went down"));
                return;
            }

            const chunk = Buffer.alloc(bytesReceived);
            buffer.copy(chunk, 0, 0, bytesReceived);

            readRequested = false;
            updatePoll();
            maybeScheduleNext();

            const takesMore = duplex.push(chunk);
            mayReadMore = takesMore;
            return;
        }

        updatePoll();
    });

    const maybeScheduleNext = () => {
        if (scheduledNext.pending()) {
            return;
        }

        scheduledNext = scheduleMicrotask(() => {
            next();
        });
    };

    const duplex = new nodeStreamModule.Duplex({
        read: (size) => {
            readRequested = true;
            mayReadMore = true;

            maybeScheduleNext();
        },

        write: (chunk, encoding, callback) => {

            // push due to performance, immutable would be better
            sendQueue.push({
                chunk: chunk,
                callback: callback,
            });

            maybeScheduleNext();
        },

        final: () => {
            throw new Error("cannot end ethernet stream");
        },

        destroy: (error, callback) => {
            destroyed = true;
            socket.close();
            callback(error);
        }
    });

    return duplex;
};

export {
    createAndSteal
};
