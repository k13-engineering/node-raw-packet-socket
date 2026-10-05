import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "mocha";
import type nodeStream from "node:stream";
import { createAndSteal } from "./socket-duplex.ts";
import { createSocketFactory } from "./socket.ts";
import {
  assertKernelClean,
  createFrame,
  createTestEnvironment,
  defined,
  errnoCodes,
  kernelAbi
} from "./test-support/environment.ts";
import type { TFakeKernel } from "./test-support/fake-kernel.ts";

const { constants } = kernelAbi;

const UV_EBADF = -9;

const eth0 = 2;

const nextError = ({ duplex }: { duplex: nodeStream.Duplex }) => {
  return new Promise<Error>((resolve) => {
    duplex.once("error", resolve);
  });
};

const closed = ({ duplex }: { duplex: nodeStream.Duplex }) => {
  return new Promise((resolve) => {
    duplex.once("close", resolve);
  });
};

const collectFrames = ({ duplex, count }: { duplex: nodeStream.Duplex, count: number }) => {
  return new Promise<Uint8Array[]>((resolve) => {
    let frames: Uint8Array[] = [];

    duplex.on("data", (frame: Uint8Array) => {
      frames = [...frames, frame];
      if (frames.length === count) {
        resolve(frames);
      }
    });
  });
};

const write = ({ duplex, frame }: { duplex: nodeStream.Duplex, frame: Uint8Array }) => {
  return new Promise<void>((resolve, reject) => {
    duplex.write(frame, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

const ticks = async ({ count }: { count: number }) => {
  for (let tick = 0; tick < count; tick += 1) {
    await new Promise(setImmediate);
  }
};

describe("socket duplex", () => {

  let fakeKernel: TFakeKernel;
  let duplex: nodeStream.Duplex;

  beforeEach(() => {
    const environment = createTestEnvironment();
    fakeKernel = environment.fakeKernel;

    const socketFactory = createSocketFactory({ po6: environment.po6, kernelAbi, createPoller: fakeKernel.kernel.createPoller });
    const { socket } = socketFactory.create({
      domain: constants.AF_PACKET,
      type: constants.SOCK_RAW | constants.SOCK_NONBLOCK,
      protocol: 0n
    });

    const sockaddr = kernelAbi.sockaddr_ll.format({
      value: {
        sll_family: constants.AF_PACKET,
        sll_protocol: constants.ETH_P_ALL,
        sll_ifindex: BigInt(eth0),
        sll_hatype: 0n,
        sll_pkttype: 0n,
        sll_halen: 0n,
        sll_addr: new Uint8Array(8),
      }
    });
    defined({ value: socket }).bind({ sockaddr });

    duplex = createAndSteal({
      socket: defined({ value: socket }),
      errnoCodes,
      createErrorFromErrno: environment.po6.createErrorFromErrno
    });
  });

  afterEach(async () => {
    if (!duplex.closed) {
      const duplexClosed = closed({ duplex });
      duplex.destroy();
      await duplexClosed;
    }

    assertKernelClean({ fakeKernel });
  });

  const recvmsgCalls = () => {
    return fakeKernel.calls().filter((call) => {
      return call.operation === "recvmsg";
    }).length;
  };

  it("should push the frames the socket receives", async () => {
    const first = createFrame({ payload: "first" });
    const second = createFrame({ payload: "second", length: 1514 });
    const third = createFrame({ payload: "third" });

    fakeKernel.receiveFrame({ ifindex: eth0, frame: first });
    fakeKernel.receiveFrame({ ifindex: eth0, frame: second });

    const frames = collectFrames({ duplex, count: 3 });
    await ticks({ count: 2 });
    fakeKernel.receiveFrame({ ifindex: eth0, frame: third });

    assert.deepStrictEqual((await frames).map((frame) => {
      return new Uint8Array(frame);
    }), [first, second, third]);
  });

  it("should not read from the socket while idle", async () => {
    duplex.resume();
    await ticks({ count: 5 });

    // one recvmsg() that fails with EAGAIN, then the poller waits
    assert.strictEqual(recvmsgCalls(), 1);
    assert.notStrictEqual(fakeKernel.pollerOf({ fd: fakeKernel.openFds()[0] })?.armed?.readable, undefined);
  });

  it("should stop reading from the socket while the consumer does not keep up", async () => {
    // twice as many as fit below the high water mark
    const frameCount = Math.ceil(2 * duplex.readableHighWaterMark / 1500);
    const frames = Array.from({ length: frameCount }).map((_, index) => {
      return createFrame({ payload: `frame ${index}`, length: 1500 });
    });

    frames.forEach((frame) => {
      fakeKernel.receiveFrame({ ifindex: eth0, frame });
    });

    // reads until the buffer of the duplex reaches its high water mark
    duplex.read(0);
    await ticks({ count: 5 });

    assert.ok(recvmsgCalls() < frames.length, `read ${recvmsgCalls()} of ${frames.length} frames`);
    assert.ok(duplex.readableLength >= duplex.readableHighWaterMark);

    const received = await collectFrames({ duplex, count: frames.length });
    assert.deepStrictEqual(received.map((frame) => {
      return new Uint8Array(frame);
    }), frames);
  });

  it("should send the written frames", async () => {
    const first = createFrame({ payload: "first" });
    const second = createFrame({ payload: "second" });

    await write({ duplex, frame: first });
    await write({ duplex, frame: second });

    assert.deepStrictEqual(fakeKernel.interfaceState({ name: "eth0" }).sentFrames, [first, second]);
  });

  it("should wait until the socket takes more frames", async () => {
    const first = createFrame({ payload: "first" });
    const second = createFrame({ payload: "second" });

    fakeKernel.setSendCapacity({ frames: 0 });

    let written = 0;
    const writes = Promise.all([first, second].map(async (frame) => {
      await write({ duplex, frame });
      written += 1;
    }));

    await ticks({ count: 5 });
    assert.strictEqual(written, 0);
    assert.deepStrictEqual(fakeKernel.interfaceState({ name: "eth0" }).sentFrames, []);

    fakeKernel.setSendCapacity({ frames: 2 });
    await writes;

    assert.deepStrictEqual(fakeKernel.interfaceState({ name: "eth0" }).sentFrames, [first, second]);
  });

  describe("errors", () => {

    const expectError = async ({ trigger }: { trigger: () => void }) => {
      const error = nextError({ duplex });
      const duplexClosed = closed({ duplex });

      trigger();

      const result = await error;
      await duplexClosed;
      return result;
    };

    it("should fail with errors of recvmsg()", async () => {
      fakeKernel.injectErrno({ operation: "recvmsg", errno: errnoCodes.ENETDOWN });

      const error = await expectError({
        trigger: () => {
          duplex.resume();
        }
      });

      assert.strictEqual(error.message, "recvmsg() failed with ENETDOWN: Network is down");
    });

    it("should fail with truncated frames", async () => {
      const error = await expectError({
        trigger: () => {
          fakeKernel.receiveFrame({ ifindex: eth0, frame: createFrame({ payload: "jumbo", length: 70_000 }) });
          duplex.resume();
        }
      });

      assert.strictEqual(error.message, "unexpected msg_flags 0x20 from recvmsg()");
    });

    it("should fail with the interface going down on zero-sized reads", async () => {
      const error = await expectError({
        trigger: () => {
          fakeKernel.receiveFrame({ ifindex: eth0, frame: new Uint8Array(0) });
          duplex.resume();
        }
      });

      assert.deepStrictEqual(error, Error("interface went down", { cause: Error("zero-sized read from recvmsg()") }));
    });

    it("should fail with errors of the poller", async () => {
      const error = await expectError({
        trigger: () => {
          duplex.resume();
          fakeKernel.failPolling({ ifindex: eth0, errorCode: UV_EBADF });
        }
      });

      assert.deepStrictEqual(error, Error("interface went down"));
    });

    it("should fail with errors of sendmsg()", async () => {
      fakeKernel.injectErrno({ operation: "sendmsg", errno: errnoCodes.ENOBUFS });

      const error = await expectError({
        trigger: () => {
          duplex.write(createFrame({ payload: "lost" }));
        }
      });

      assert.strictEqual(error.message, "sendmsg() failed with ENOBUFS: No buffer space available");
    });

    it("should fail with short writes", async () => {
      fakeKernel.setShortWrites({ enabled: true });

      const error = await expectError({
        trigger: () => {
          duplex.write(createFrame({ payload: "short" }));
        }
      });

      assert.strictEqual(error.message, "short write on sendmsg(), sent 59 of 60 bytes");
    });

    it("should fail when it is ended", async () => {
      const error = await expectError({
        trigger: () => {
          duplex.end();
        }
      });

      assert.strictEqual(error.message, "cannot end ethernet stream");
    });
  });

  it("should close the poller and the socket when destroyed", async () => {
    duplex.resume();
    await ticks({ count: 2 });

    const duplexClosed = closed({ duplex });
    duplex.destroy();
    await duplexClosed;

    assert.deepStrictEqual(fakeKernel.openFds(), []);
  });
});
