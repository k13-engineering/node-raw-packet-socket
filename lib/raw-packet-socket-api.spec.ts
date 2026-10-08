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
  kernelAbi,
  tagFrame
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
        disableHardwareGenericReceiveOffloadUntilReboot: true,
        disableLargeReceiveOffloadUntilReboot: true,
        disableUdpSegmentationOffloadUntilReboot: true,
        disableTransmitChecksumOffloadUntilReboot: true,
        disableVlanFilterUntilReboot: true,
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
      assert.ok(activeFeatures.includes("rx-gro-hw"));
      assert.ok(activeFeatures.includes("tx-generic-segmentation"));
      assert.ok(activeFeatures.includes("tx-tcp-segmentation"));
      assert.ok(activeFeatures.includes("rx-vlan-filter"));

      await destroy({ duplex });
    });

    it("should enable the promiscuous mode for as long as the socket is open", async () => {
      const duplex = await open({ ifindex: eth0, enablePromiscuousMode: true });

      assert.strictEqual(fakeKernel.interfaceState({ name: "eth0" }).promiscuity, 1);

      await destroy({ duplex });

      assert.strictEqual(fakeKernel.interfaceState({ name: "eth0" }).promiscuity, 0);
    });

    it("should receive the frames the host sends on the interface as well by default", async () => {
      const duplex = await open({ ifindex: eth0 });

      const outgoing = createFrame({ payload: "outgoing" });
      const received = new Promise<Uint8Array>((resolve) => {
        duplex.once("data", resolve);
      });
      fakeKernel.sendFrameOfHost({ ifindex: eth0, frame: outgoing });
      assert.deepStrictEqual(new Uint8Array(await received), outgoing);

      await destroy({ duplex });
    });

    it("should ignore the frames the host sends if asked to, from before it binds the socket", async () => {
      const duplex = await open({ ifindex: eth0, ignoreOutgoingFrames: true });

      assert.deepStrictEqual(operations().slice(0, 3), ["socket:AF_PACKET", "setsockopt", "bind"]);

      const incoming = createFrame({ payload: "incoming" });
      const received = new Promise<Uint8Array>((resolve) => {
        duplex.once("data", resolve);
      });
      fakeKernel.sendFrameOfHost({ ifindex: eth0, frame: createFrame({ payload: "outgoing" }) });
      fakeKernel.receiveFrame({ ifindex: eth0, frame: incoming });
      assert.deepStrictEqual(new Uint8Array(await received), incoming);

      await destroy({ duplex });
    });

    const receiveOne = async ({ duplex, frame }: { duplex: nodeStream.Duplex, frame: Uint8Array }) => {
      const received = new Promise<Uint8Array>((resolve) => {
        duplex.once("data", resolve);
      });
      fakeKernel.receiveFrame({ ifindex: eth0, frame });
      return new Uint8Array(await received);
    };

    it("should deliver frames without their VLAN tag by default, as the kernel does", async () => {
      const duplex = await open({ ifindex: eth0 });

      const frame = createFrame({ payload: "tagged" });
      assert.deepStrictEqual(await receiveOne({ duplex, frame: tagFrame({ frame, tci: 42 }) }), frame);

      await destroy({ duplex });
    });

    it("should restore the VLAN tags if asked to", async () => {
      const duplex = await open({ ifindex: eth0, restoreVlanTags: true });

      assert.deepStrictEqual(operations().slice(0, 3), ["socket:AF_PACKET", "setsockopt", "bind"]);

      const tagged = tagFrame({ frame: createFrame({ payload: "tagged" }), tci: 42 });
      assert.deepStrictEqual(await receiveOne({ duplex, frame: tagged }), tagged);

      const untagged = createFrame({ payload: "untagged" });
      assert.deepStrictEqual(await receiveOne({ duplex, frame: untagged }), untagged);

      await destroy({ duplex });
    });

    describe("timing", () => {
      // the interface index belongs to the network namespace of the caller,
      // who might switch namespaces again right after the call
      it("should open, set up and bind the socket before it returns", async () => {
        const duplex = api.createNodeDuplexByInterfaceIndex({
          ifindex: eth0,
          disableGenericReceiveOffloadUntilReboot: true,
          enablePromiscuousMode: true,
          ignoreOutgoingFrames: true,
          restoreVlanTags: true,
        });

        const operationsWhenReturned = operations();
        assert.deepStrictEqual(operationsWhenReturned.slice(0, 4), ["socket:AF_PACKET", "setsockopt", "setsockopt", "bind"]);
        assert.deepStrictEqual(operationsWhenReturned.slice(-3), ["close", "setsockopt", "PACKET_ADD_MEMBERSHIP"]);
        assert.ok(!fakeKernel.interfaceState({ name: "eth0" }).activeFeatures.includes("rx-gro"));
        assert.strictEqual(fakeKernel.interfaceState({ name: "eth0" }).promiscuity, 1);

        await new Promise((resolve) => {
          duplex.once("ready", resolve);
        });

        assert.deepStrictEqual(operations().slice(0, operationsWhenReturned.length), operationsWhenReturned);

        await destroy({ duplex });
      });

      it("should receive the frames arriving right after it returns", async () => {
        const duplex = api.createNodeDuplexByInterfaceIndex({ ifindex: eth0 });

        const incoming = createFrame({ payload: "early" });
        fakeKernel.receiveFrame({ ifindex: eth0, frame: incoming });

        const received = await new Promise<Uint8Array>((resolve) => {
          duplex.once("data", resolve);
        });
        assert.deepStrictEqual(new Uint8Array(received), incoming);

        await destroy({ duplex });
      });

      it("should close the socket if destroyed right away", async () => {
        const duplex = api.createNodeDuplexByInterfaceIndex({ ifindex: eth0 });

        let events: string[] = [];
        ["open", "ready", "error"].forEach((event) => {
          duplex.once(event, () => {
            events = [...events, event];
          });
        });

        await destroy({ duplex });
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });

        assert.deepStrictEqual(operations(), ["socket:AF_PACKET", "bind", "close"]);
        assert.deepStrictEqual(events, []);
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

      it("should close the socket before it returns, but report the error in another task", async () => {
        const duplex = api.createNodeDuplexByInterfaceIndex({ ifindex: 42 });

        assert.deepStrictEqual(operations(), ["socket:AF_PACKET", "bind", "close"]);
        assert.deepStrictEqual(fakeKernel.openFds(), []);

        await Promise.resolve();

        const duplexClosed = closed({ duplex });
        const error = await new Promise<Error>((resolve) => {
          duplex.once("error", resolve);
        });
        await duplexClosed;

        assert.strictEqual(error.message, "bind() failed with ENODEV: No such device");
      });

      it("should not report the error if destroyed right away", async () => {
        const duplex = api.createNodeDuplexByInterfaceIndex({ ifindex: 42 });

        let errored = false;
        duplex.once("error", () => {
          errored = true;
        });

        await destroy({ duplex });
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });

        assert.strictEqual(errored, false);
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

      it("should fail if outgoing frames cannot be ignored, e.g. before Linux 4.20", async () => {
        fakeKernel.injectErrno({ operation: "setsockopt", errno: errnoCodes.ENOPROTOOPT });

        const error = await openFailure({ ifindex: eth0, ignoreOutgoingFrames: true });

        assert.strictEqual(error.message, "setsockopt(PACKET_IGNORE_OUTGOING) failed with ENOPROTOOPT: Protocol not available");
      });

      it("should fail if the VLAN tags cannot be restored", async () => {
        fakeKernel.injectErrno({ operation: "setsockopt", errno: errnoCodes.ENOPROTOOPT });

        const error = await openFailure({ ifindex: eth0, restoreVlanTags: true });

        assert.strictEqual(error.message, "setsockopt(PACKET_AUXDATA) failed with ENOPROTOOPT: Protocol not available");
      });

      it("should fail if the promiscuous mode cannot be enabled", async () => {
        fakeKernel.injectErrno({ operation: "setsockopt", errno: errnoCodes.ENOBUFS });

        const error = await openFailure({ ifindex: eth0, enablePromiscuousMode: true });

        assert.strictEqual(error.message, "setsockopt(PACKET_ADD_MEMBERSHIP) failed with ENOBUFS: No buffer space available");
      });
    });
  });

  describe("disableOffloadsUntilReboot", () => {
    it("should disable offloads without opening a packet socket", () => {
      const { error } = api.disableOffloadsUntilReboot({ ifindex: eth0, offloads: ["generic-receive-offload", "rx-gro-hw"] });

      assert.strictEqual(error, undefined);

      const { activeFeatures } = fakeKernel.interfaceState({ name: "eth0" });
      assert.ok(!activeFeatures.includes("rx-gro"));
      assert.ok(!activeFeatures.includes("rx-gro-hw"));
      assert.ok(activeFeatures.includes("rx-lro"));
      assert.deepStrictEqual(operations().slice(0, 3), ["socket:AF_INET", "SIOCGIFNAME", "SIOCETHTOOL"]);
      assert.ok(!operations().includes("socket:AF_PACKET"));
    });

    it("should not talk to the kernel without offloads", () => {
      assert.deepStrictEqual(api.disableOffloadsUntilReboot({ ifindex: eth0, offloads: [] }), { error: undefined });

      assert.deepStrictEqual(fakeKernel.calls(), []);
    });

    it("should fail for unknown interfaces", () => {
      const { error } = api.disableOffloadsUntilReboot({ ifindex: 42, offloads: ["rx-gro-hw"] });

      assert.strictEqual(error?.message, "interface index 42 not found");
    });

    it("should reject unknown offloads before talking to the kernel", () => {
      // @ts-expect-error as from JavaScript
      const { error } = api.disableOffloadsUntilReboot({ ifindex: eth0, offloads: ["generic-receive-offload", "toString"] });

      assert.strictEqual(error?.message, `unknown offload "toString"`);
      assert.deepStrictEqual(fakeKernel.calls(), []);
    });
  });
});
