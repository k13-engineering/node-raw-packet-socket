import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "mocha";
import type nodeStream from "node:stream";
import {
  createRawPacketSocketApi,
  type TCreateNodeDuplexByInterfaceIndexArgs
} from "./raw-packet-socket-api.ts";
import {
  assertKernelClean,
  createFrame,
  errnoCodes,
  kernelAbi
} from "./test-support/environment.ts";
import { createFakeKernel, type TFakeKernel } from "./test-support/fake-kernel.ts";

const { constants } = kernelAbi;

const eth0 = 2;

const closed = ({ duplex }: { duplex: nodeStream.Duplex }) => {
  return new Promise((resolve) => {
    duplex.once("close", resolve);
  });
};

const destroy = async ({ duplex }: { duplex: nodeStream.Duplex }) => {
  const duplexClosed = closed({ duplex });
  duplex.destroy();
  await duplexClosed;
};

describe("raw packet socket API", () => {

  let fakeKernel: TFakeKernel;
  let api: ReturnType<typeof createRawPacketSocketApi>;

  beforeEach(() => {
    fakeKernel = createFakeKernel({ kernelAbi });
    api = createRawPacketSocketApi({ kernel: fakeKernel.kernel, kernelAbi });
  });

  afterEach(() => {
    assertKernelClean({ fakeKernel });
  });

  const operations = () => {
    return fakeKernel.calls().map((call) => {
      return call.operation;
    });
  };

  const open = async (args: TCreateNodeDuplexByInterfaceIndexArgs) => {
    const duplex = api.createNodeDuplexByInterfaceIndex(args);

    let events: string[] = [];
    ["open", "ready"].forEach((event) => {
      duplex.once(event, () => {
        events = [...events, event];
      });
    });

    await new Promise((resolve, reject) => {
      duplex.once("ready", resolve);
      duplex.once("error", reject);
    });

    assert.deepStrictEqual(events, ["open", "ready"]);

    return duplex;
  };

  const openFailure = async (args: TCreateNodeDuplexByInterfaceIndexArgs) => {
    const duplex = api.createNodeDuplexByInterfaceIndex(args);
    const duplexClosed = closed({ duplex });

    const error = await new Promise<Error>((resolve, reject) => {
      duplex.once("error", resolve);
      duplex.once("ready", () => {
        reject(Error("unexpectedly ready"));
      });
    });

    await duplexClosed;
    return error;
  };

  it("should find interface indexes by name", () => {
    assert.deepStrictEqual(api.findInterfaceIndexByName({ interfaceName: "eth0" }), { error: undefined, ifindex: eth0 });
  });

  describe("createNodeDuplexByInterfaceIndex", () => {
    it("should open a non-blocking packet socket bound to the interface", async () => {
      const duplex = await open({ ifindex: eth0 });

      assert.deepStrictEqual(fakeKernel.calls().slice(0, 2), [
        { operation: "socket:AF_PACKET", type: constants.SOCK_RAW | constants.SOCK_NONBLOCK | constants.SOCK_CLOEXEC, protocol: 0n },
        { operation: "bind", fd: 100 },
      ]);

      await destroy({ duplex });
    });

    it("should receive and send frames", async () => {
      const duplex = await open({ ifindex: eth0 });

      const incoming = createFrame({ payload: "incoming" });
      const received = new Promise<Uint8Array>((resolve) => {
        duplex.once("data", resolve);
      });
      fakeKernel.receiveFrame({ ifindex: eth0, frame: incoming });
      assert.deepStrictEqual(new Uint8Array(await received), incoming);

      const outgoing = createFrame({ payload: "outgoing" });
      await new Promise((resolve) => {
        duplex.write(outgoing, resolve);
      });
      assert.deepStrictEqual(fakeKernel.interfaceState({ name: "eth0" }).sentFrames, [outgoing]);

      await destroy({ duplex });
    });

    it("should leave the offloads and the promiscuous mode alone by default", async () => {
      const duplex = await open({ ifindex: eth0 });

      assert.deepStrictEqual(operations().filter((operation) => {
        return !["recvmsg", "sendmsg"].includes(operation);
      }), ["socket:AF_PACKET", "bind"]);

      await destroy({ duplex });
    });

    it("should disable the offloads it is asked to, on a separate socket", async () => {
      const duplex = await open({
        ifindex: eth0,
        disableTcpSegmentationOffloadUntilReboot: true,
        disableGenericSegmentationOffloadUntilReboot: true,
        disableGenericReceiveOffloadUntilReboot: true,
      });

      assert.deepStrictEqual(fakeKernel.interfaceState({ name: "eth0" }).activeFeatures, []);
      assert.deepStrictEqual(operations().slice(0, 5), ["socket:AF_PACKET", "bind", "socket:AF_INET", "SIOCGIFNAME", "SIOCETHTOOL"]);
      assert.ok(fakeKernel.calls().filter((call) => {
        return call.operation === "ETHTOOL_SFEATURES";
      }).every((call) => {
        return call.interfaceName === "eth0";
      }));

      await destroy({ duplex });
    });

    it("should only disable the offloads it is asked to", async () => {
      const duplex = await open({ ifindex: eth0, disableGenericReceiveOffloadUntilReboot: true });

      const { activeFeatures } = fakeKernel.interfaceState({ name: "eth0" });
      assert.ok(!activeFeatures.includes("rx-gro"));
      assert.ok(activeFeatures.includes("tx-generic-segmentation"));
      assert.ok(activeFeatures.includes("tx-tcp-segmentation"));

      await destroy({ duplex });
    });

    it("should enable the promiscuous mode for as long as the socket is open", async () => {
      const duplex = await open({ ifindex: eth0, enablePromiscuousMode: true });

      assert.strictEqual(fakeKernel.interfaceState({ name: "eth0" }).promiscuity, 1);

      await destroy({ duplex });

      assert.strictEqual(fakeKernel.interfaceState({ name: "eth0" }).promiscuity, 0);
    });

    it("should not open a socket if destroyed right away", async () => {
      const duplex = api.createNodeDuplexByInterfaceIndex({ ifindex: eth0 });

      await destroy({ duplex });
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });

      assert.deepStrictEqual(fakeKernel.calls(), []);
    });

    it("should not emit ready if destroyed when open", async () => {
      const duplex = api.createNodeDuplexByInterfaceIndex({ ifindex: eth0 });

      let ready = false;
      duplex.once("ready", () => {
        ready = true;
      });

      const duplexClosed = closed({ duplex });
      duplex.once("open", () => {
        duplex.destroy();
      });
      await duplexClosed;

      assert.strictEqual(ready, false);
    });

    describe("errors", () => {
      it("should fail if the socket cannot be created", async () => {
        fakeKernel.injectErrno({ operation: "socket:AF_PACKET", errno: errnoCodes.EPERM });

        const error = await openFailure({ ifindex: eth0 });

        assert.strictEqual(error.message, "socket() failed with EPERM: Operation not permitted");
      });

      it("should fail and close the socket if it cannot be bound", async () => {
        const error = await openFailure({ ifindex: 42 });

        assert.strictEqual(error.message, "bind() failed with ENODEV: No such device");
      });

      it("should fail if the interface name cannot be found to disable offloads", async () => {
        fakeKernel.injectErrno({ operation: "SIOCGIFNAME", errno: errnoCodes.ENODEV });

        const error = await openFailure({ ifindex: eth0, disableTcpSegmentationOffloadUntilReboot: true });

        assert.strictEqual(error.message, "interface index 2 not found");
      });

      it("should fail if there is no socket to disable offloads", async () => {
        fakeKernel.injectErrno({ operation: "socket:AF_INET", errno: errnoCodes.EMFILE });

        const error = await openFailure({ ifindex: eth0, disableGenericSegmentationOffloadUntilReboot: true });

        assert.strictEqual(error.message, "socket() failed with EMFILE: Too many open files");
      });

      it("should fail if offloads cannot be disabled", async () => {
        fakeKernel.injectErrno({ operation: "ETHTOOL_SFEATURES", errno: errnoCodes.EPERM });

        const error = await openFailure({ ifindex: eth0, disableGenericReceiveOffloadUntilReboot: true });

        assert.strictEqual(error.message, "ioctl(SIOCETHTOOL, ETHTOOL_SFEATURES) failed with EPERM: Operation not permitted");
      });

      it("should fail if the promiscuous mode cannot be enabled", async () => {
        fakeKernel.injectErrno({ operation: "setsockopt", errno: errnoCodes.ENOBUFS });

        const error = await openFailure({ ifindex: eth0, enablePromiscuousMode: true });

        assert.strictEqual(error.message, "setsockopt(PACKET_ADD_MEMBERSHIP) failed with ENOBUFS: No buffer space available");
      });
    });
  });
});
