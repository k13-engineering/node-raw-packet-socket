import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { createPo6Api } from "po6";
import { createDefaultKernel } from "./kernel.ts";
import { defined, kernelAbi } from "./test-support/environment.ts";

const { constants } = kernelAbi;

// struct sockaddr_in for 127.0.0.1 and a port chosen by the kernel
const loopbackSockaddrIn = () => {
  const sockaddr = new Uint8Array(16);
  new DataView(sockaddr.buffer).setUint16(0, Number(constants.AF_INET), true);
  sockaddr.set([127, 0, 0, 1], 4);
  return sockaddr;
};

describe("default kernel", () => {

  const kernel = createDefaultKernel();
  const po6 = createPo6Api({ kernelInterface: kernel.kernelInterface, kernelAbi: kernelAbi.po6, memory: kernel.memory });

  // a UDP socket bound to the loopback interface, which needs no privileges
  const openUdpSocket = () => {
    const { errno, fd } = po6.socket({
      domain: constants.AF_INET,
      type: constants.SOCK_DGRAM | constants.SOCK_NONBLOCK | constants.SOCK_CLOEXEC,
      protocol: 0
    });
    assert.strictEqual(errno, undefined);

    assert.deepStrictEqual(po6.bind({ fd: defined({ value: fd }), sockaddr: loopbackSockaddrIn() }), { errno: undefined });

    return defined({ value: fd });
  };

  const readable = ({ poller }: { poller: ReturnType<typeof kernel.createPoller> }) => {
    return new Promise<void>((resolve, reject) => {
      poller.armOnce({
        readable: resolve,
        error: ({ errorCode }) => {
          reject(Error(`polling failed with ${errorCode}`));
        }
      });
    });
  };

  it("should perform syscalls, pin buffers and poll file descriptors of the host", async () => {
    const fd = openUdpSocket();
    const poller = kernel.createPoller({ fd });

    try {
      const data = new Uint8Array(16);
      assert.strictEqual(po6.recvmsg({ fd, data }).errno, kernelAbi.po6.errnoCodes.EAGAIN);

      const socketReadable = readable({ poller });

      // sends the datagram to the socket itself, po6 pins msg_name as struct msghdr points to it
      const { sockaddr } = po6.getsockname({ fd });
      const payload = new TextEncoder().encode("hello");
      assert.deepStrictEqual(po6.sendmsg({ fd, data: payload, msghdr: { msg_name: sockaddr } }), { errno: undefined, bytesSent: 5 });

      await socketReadable;

      const { errno, bytesReceived } = po6.recvmsg({ fd, data });
      assert.strictEqual(errno, undefined);
      assert.strictEqual(new TextDecoder().decode(data.subarray(0, bytesReceived)), "hello");
    } finally {
      poller.close();
      po6.close({ fd });
    }
  });
});
