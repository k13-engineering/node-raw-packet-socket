// Runs in a network namespace with the veth pair veth0 and veth1: opens a
// duplex on each end, sends a frame from veth1 to veth0 and prints what
// happened as JSON.

import nodeChildProcess from "node:child_process";
import nodeProcess from "node:process";
import type nodeStream from "node:stream";
import {
  createNodeDuplexByInterfaceIndex,
  disableOffloadsUntilReboot,
  findInterfaceIndexByName
} from "../index.ts";
import { createFrame, tagFrame } from "./environment.ts";

const ifindexOf = ({ interfaceName }: { interfaceName: string }) => {
  const { error, ifindex } = findInterfaceIndexByName({ interfaceName });
  if (error !== undefined) {
    throw error;
  }
  return ifindex;
};

const ready = ({ duplex }: { duplex: nodeStream.Duplex }) => {
  return new Promise((resolve, reject) => {
    duplex.once("ready", resolve);
    duplex.once("error", reject);
  });
};

// the lines of `ethtool -k` of the offloads the receiver disables, with their features
const offloadLine = new RegExp(`^(${[
  "tx-checksumming", "\\ttx-checksum-.*",
  "tcp-segmentation-offload", "\\ttx-tcp.*-segmentation",
  "tx-udp-segmentation",
  "generic-segmentation-offload",
  "generic-receive-offload",
  "rx-gro-hw",
  "large-receive-offload",
].join("|")}):`);

// ethtool is not needed by the library, but checks its work independently where available
const offloadsOf = ({ interfaceName }: { interfaceName: string }) => {
  try {
    const output = nodeChildProcess.execFileSync("ethtool", ["-k", interfaceName], { encoding: "utf8" });
    return output.split("\n").filter((line) => {
      return offloadLine.test(line);
    }).map((line) => {
      return line.trim();
    });
  } catch {
    return undefined;
  }
};

const promiscuityOf = ({ interfaceName }: { interfaceName: string }) => {
  const output = nodeChildProcess.execFileSync("ip", ["-details", "link", "show", interfaceName], { encoding: "utf8" });
  return Number(/promiscuity (\d+)/.exec(output)?.[1]);
};

const receiver = createNodeDuplexByInterfaceIndex({
  ifindex: ifindexOf({ interfaceName: "veth0" }),
  disableTcpSegmentationOffloadUntilReboot: true,
  disableGenericSegmentationOffloadUntilReboot: true,
  disableGenericReceiveOffloadUntilReboot: true,
  disableHardwareGenericReceiveOffloadUntilReboot: true,
  disableLargeReceiveOffloadUntilReboot: true,
  disableUdpSegmentationOffloadUntilReboot: true,
  disableTransmitChecksumOffloadUntilReboot: true,
  enablePromiscuousMode: true,
  restoreVlanTags: true,
});

// before the sender opens its socket on the interface
const { error: disableError } = disableOffloadsUntilReboot({
  ifindex: ifindexOf({ interfaceName: "veth1" }),
  offloads: ["tx-checksumming"]
});
if (disableError !== undefined) {
  throw disableError;
}

const sender = createNodeDuplexByInterfaceIndex({ ifindex: ifindexOf({ interfaceName: "veth1" }) });

// sees the frame of the sender as outgoing and the reply of the receiver as incoming
const watcher = createNodeDuplexByInterfaceIndex({ ifindex: ifindexOf({ interfaceName: "veth1" }), ignoreOutgoingFrames: true });

await Promise.all([ready({ duplex: receiver }), ready({ duplex: sender }), ready({ duplex: watcher })]);

// the next frame with the experimental ethertype, ignoring e.g. IPv6 router solicitations
const nextExperimentalFrame = ({ duplex, ethertypeOffset = 12 }: { duplex: nodeStream.Duplex, ethertypeOffset?: number }) => {
  return new Promise<Uint8Array>((resolve) => {
    duplex.on("data", (packet: Uint8Array) => {
      if (packet[ethertypeOffset] === 0x88 && packet[ethertypeOffset + 1] === 0xb5) {
        resolve(packet);
      }
    });
  });
};

const payloadOf = ({ packet }: { packet: Uint8Array }) => {
  return new TextDecoder().decode(packet.subarray(14, 29));
};

const received = nextExperimentalFrame({ duplex: receiver });
const watched = nextExperimentalFrame({ duplex: watcher });

sender.write(createFrame({ payload: "hello over veth" }));

const packet = await received;

// VLAN 42, which the kernel takes out of the frame on veth0
const receivedTagged = nextExperimentalFrame({ duplex: receiver, ethertypeOffset: 16 });
sender.write(tagFrame({ frame: createFrame({ payload: "tagged over veth" }), tci: 42 }));
const taggedPacket = await receivedTagged;

// the frame of the sender is queued on the watcher by now, unless it is ignored
receiver.write(createFrame({ payload: "reply over veth" }));

const result = {
  received: payloadOf({ packet }),
  receivedLength: packet.length,
  vlanTag: Array.from(taggedPacket.subarray(12, 16), (byte) => {
    return byte.toString(16).padStart(2, "0");
  }).join(""),
  taggedLength: taggedPacket.length,
  watched: payloadOf({ packet: await watched }),
  promiscuity: promiscuityOf({ interfaceName: "veth0" }),
  offloads: offloadsOf({ interfaceName: "veth0" }),
  offloadsWithoutSocket: offloadsOf({ interfaceName: "veth1" })?.filter((line) => {
    return line.startsWith("tx-checksumming:");
  }),
};

const closed = [receiver, sender, watcher].map((duplex) => {
  return new Promise((resolve) => {
    duplex.once("close", resolve);
    duplex.destroy();
  });
});
await Promise.all(closed);

nodeProcess.stdout.write(JSON.stringify({ ...result, promiscuityAfterClose: promiscuityOf({ interfaceName: "veth0" }) }));
