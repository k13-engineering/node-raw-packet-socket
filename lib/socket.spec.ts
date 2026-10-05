import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "mocha";
import { createSocketFactory, type TSocket, type TSocketEvents } from "./socket.ts";
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

// libuv's error codes, as the poller reports them
const UV_EBADF = -9;
const UV_EIO = -5;

const eth0 = 2;

const packetSocketType = constants.SOCK_RAW | constants.SOCK_NONBLOCK | constants.SOCK_CLOEXEC;

const sockaddrFor = ({ ifindex }: { ifindex: number }) => {
  return kernelAbi.sockaddr_ll.format({
    value: {
      sll_family: constants.AF_PACKET,
      sll_protocol: constants.ETH_P_ALL,
      sll_ifindex: BigInt(ifindex),
      sll_hatype: 0n,
      sll_pkttype: 0n,
      sll_halen: 0n,
      sll_addr: new Uint8Array(8),
    }
  });
};

const nextPollerEvent = ({ socket }: { socket: TSocket }) => {
  return new Promise<{ events: TSocketEvents, poller: ReturnType<TSocket["poller"]> } | { error: Error }>((resolve) => {
    const poller = socket.poller({
      callback: ({ events }) => {
        resolve({ events, poller });
      },
      onError: ({ error }) => {
        resolve({ error });
      }
    });

    poller.update({ events: { readable: true, writable: true } });
  });
};

describe("socket", () => {

  let fakeKernel: TFakeKernel;
  let socketFactory: ReturnType<typeof createSocketFactory>;

  beforeEach(() => {
    const environment = createTestEnvironment();
    fakeKernel = environment.fakeKernel;
    socketFactory = createSocketFactory({ po6: environment.po6, kernelAbi, createPoller: fakeKernel.kernel.createPoller });
  });

  afterEach(() => {
    assertKernelClean({ fakeKernel });
  });

  const createPacketSocket = () => {
    const { error, socket } = socketFactory.create({ domain: constants.AF_PACKET, type: packetSocketType, protocol: 0n });
    assert.strictEqual(error, undefined);
    return defined({ value: socket });
  };

  const createBoundPacketSocket = () => {
    const socket = createPacketSocket();
    assert.deepStrictEqual(socket.bind({ sockaddr: sockaddrFor({ ifindex: eth0 }) }), { errno: undefined });
    return socket;
  };

  it("should create sockets with the given domain, type and protocol", () => {
    const socket = createPacketSocket();

    assert.deepStrictEqual(fakeKernel.calls()[0], { operation: "socket:AF_PACKET", type: packetSocketType, protocol: 0n });

    socket.close();
  });

  it("should report errors of socket()", () => {
    fakeKernel.injectErrno({ operation: "socket:AF_PACKET", errno: errnoCodes.EPERM });

    const { error, socket } = socketFactory.create({ domain: constants.AF_PACKET, type: packetSocketType, protocol: 0n });

    assert.strictEqual(socket, undefined);
    assert.strictEqual(error?.message, "socket() failed with EPERM: Operation not permitted");
    assert.strictEqual(error?.errno, errnoCodes.EPERM);
  });

  it("should bind, receive and send", () => {
    const socket = createPacketSocket();

    assert.deepStrictEqual(socket.bind({ sockaddr: sockaddrFor({ ifindex: 42 }) }), { errno: errnoCodes.ENODEV });
    assert.deepStrictEqual(socket.bind({ sockaddr: sockaddrFor({ ifindex: eth0 }) }), { errno: undefined });

    const data = new Uint8Array(100);
    assert.strictEqual(socket.recvmsg({ data }).errno, errnoCodes.EAGAIN);

    const incoming = createFrame({ payload: "incoming" });
    fakeKernel.receiveFrame({ ifindex: eth0, frame: incoming });

    assert.deepStrictEqual(socket.recvmsg({ data }), {
      errno: undefined,
      bytesReceived: incoming.length,
      msghdr: { msg_namelen: 0, msg_controllen: 0, msg_flags: 0 }
    });
    assert.deepStrictEqual(data.subarray(0, incoming.length), incoming);

    const outgoing = createFrame({ payload: "outgoing" });
    assert.deepStrictEqual(socket.sendmsg({ data: outgoing }), { errno: undefined, bytesSent: outgoing.length });
    assert.deepStrictEqual(fakeKernel.interfaceState({ name: "eth0" }).sentFrames, [outgoing]);

    socket.close();
  });

  describe("packet membership", () => {
    it("should add a membership without address", () => {
      const socket = createBoundPacketSocket();

      const { errno } = socket.sockopt.packet.addMembership({ ifindex: eth0, action: kernelAbi.po6.constants.PACKET_MR_PROMISC });

      assert.strictEqual(errno, undefined);
      assert.strictEqual(fakeKernel.interfaceState({ name: "eth0" }).promiscuity, 1);
      assert.deepStrictEqual(fakeKernel.calls().at(-1)?.membership, {
        ifindex: BigInt(eth0),
        type: kernelAbi.po6.constants.PACKET_MR_PROMISC,
        alen: 0n,
        address: new Uint8Array(8)
      });

      socket.close();

      // the kernel drops the membership with the socket
      assert.strictEqual(fakeKernel.interfaceState({ name: "eth0" }).promiscuity, 0);
    });

    it("should pass the address of a membership", () => {
      const socket = createBoundPacketSocket();
      const address = new Uint8Array([0x01, 0x00, 0x5e, 0x00, 0x00, 0x01]);

      socket.sockopt.packet.addMembership({ ifindex: eth0, action: kernelAbi.po6.constants.PACKET_MR_PROMISC, address });

      assert.deepStrictEqual(fakeKernel.calls().at(-1)?.membership, {
        ifindex: BigInt(eth0),
        type: kernelAbi.po6.constants.PACKET_MR_PROMISC,
        alen: 6n,
        address: new Uint8Array([0x01, 0x00, 0x5e, 0x00, 0x00, 0x01, 0x00, 0x00])
      });

      socket.close();
    });

    it("should report errors of setsockopt()", () => {
      const socket = createBoundPacketSocket();

      const { errno } = socket.sockopt.packet.addMembership({ ifindex: 42, action: kernelAbi.po6.constants.PACKET_MR_PROMISC });

      assert.strictEqual(errno, errnoCodes.ENODEV);

      socket.close();
    });
  });

  describe("poller", () => {
    it("should call back once the socket is readable", async () => {
      const socket = createBoundPacketSocket();

      // nothing to send or receive, so the poller has to wait for the frame
      fakeKernel.setSendCapacity({ frames: 0 });
      const event = nextPollerEvent({ socket });
      fakeKernel.receiveFrame({ ifindex: eth0, frame: createFrame({ payload: "wake up" }) });

      const result = await event;
      assert.ok("events" in result);
      assert.deepStrictEqual(result.events, { readable: true, writable: false });

      result.poller.close();
      socket.close();
    });

    it("should call back once the socket is writable", async () => {
      const socket = createBoundPacketSocket();

      const result = await nextPollerEvent({ socket });
      assert.ok("events" in result);
      assert.deepStrictEqual(result.events, { readable: false, writable: true });

      result.poller.close();
      socket.close();
    });

    const recordingPoller = ({ socket }: { socket: TSocket }) => {
      let events: TSocketEvents[] = [];

      const poller = socket.poller({
        callback: (args) => {
          events = [...events, args.events];
        },
        onError: () => {
          throw Error("unexpected poll error");
        }
      });

      return {
        poller,
        events: () => {
          return events;
        }
      };
    };

    it("should only arm for the requested events and disarm without events", async () => {
      const socket = createBoundPacketSocket();
      fakeKernel.setSendCapacity({ frames: 0 });
      const { poller, events } = recordingPoller({ socket });

      poller.update({ events: { readable: false, writable: true } });
      fakeKernel.receiveFrame({ ifindex: eth0, frame: createFrame({ payload: "ignored" }) });
      await new Promise(setImmediate);

      assert.deepStrictEqual(events(), []);
      assert.strictEqual(fakeKernel.pollerOf({ fd: fakeKernel.openFds()[0] })?.armed?.readable, undefined);

      poller.update({ events: { readable: false, writable: false } });
      assert.strictEqual(fakeKernel.pollerOf({ fd: fakeKernel.openFds()[0] })?.armed, undefined);

      fakeKernel.setSendCapacity({ frames: 1 });
      await new Promise(setImmediate);
      assert.deepStrictEqual(events(), []);

      poller.close();
      socket.close();
    });

    it("should report POLLERR as the interface going down", async () => {
      const socket = createBoundPacketSocket();
      fakeKernel.setSendCapacity({ frames: 0 });

      const event = nextPollerEvent({ socket });
      fakeKernel.failPolling({ ifindex: eth0, errorCode: UV_EBADF });

      assert.deepStrictEqual(await event, { error: Error("interface went down") });

      socket.close();
    });

    it("should report other poll errors with their libuv error code", async () => {
      const socket = createBoundPacketSocket();
      fakeKernel.setSendCapacity({ frames: 0 });

      const event = nextPollerEvent({ socket });
      fakeKernel.failPolling({ ifindex: eth0, errorCode: UV_EIO });

      assert.deepStrictEqual(await event, { error: Error("polling the socket failed with libuv error -5") });

      socket.close();
    });

    it("should refuse a second poller", () => {
      const socket = createBoundPacketSocket();

      const callbacks = {
        callback: () => {},
        onError: () => {}
      };

      socket.poller(callbacks);
      assert.throws(() => {
        socket.poller(callbacks);
      }, /poller already exists/);

      // closes the poller before the socket
      socket.close();
    });

    it("should not close a closed poller again when the socket is closed", () => {
      const socket = createBoundPacketSocket();

      const poller = socket.poller({
        callback: () => {},
        onError: () => {}
      });

      poller.close();
      socket.close();
    });
  });
});
