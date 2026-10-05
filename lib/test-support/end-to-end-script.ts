// Runs in a network namespace with the veth pair veth0 and veth1: opens a
// duplex on each end, sends a frame from veth1 to veth0 and prints what
// happened as JSON.

import nodeChildProcess from "node:child_process";
import nodeProcess from "node:process";
import type nodeStream from "node:stream";
import { createNodeDuplexByInterfaceIndex, findInterfaceIndexByName } from "../index.ts";
import { createFrame } from "./environment.ts";

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

// ethtool is not needed by the library, but checks its work independently where available
const offloadsOf = ({ interfaceName }: { interfaceName: string }) => {
  try {
    const output = nodeChildProcess.execFileSync("ethtool", ["-k", interfaceName], { encoding: "utf8" });
    return output.split("\n").filter((line) => {
      return /^(tcp-segmentation-offload|generic-segmentation-offload|generic-receive-offload|\ttx-tcp.*-segmentation):/.test(line);
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
  enablePromiscuousMode: true,
});

const sender = createNodeDuplexByInterfaceIndex({ ifindex: ifindexOf({ interfaceName: "veth1" }) });

await Promise.all([ready({ duplex: receiver }), ready({ duplex: sender })]);

const frame = createFrame({ payload: "hello over veth" });

const received = new Promise<Uint8Array>((resolve) => {
  receiver.on("data", (packet: Uint8Array) => {
    // ignore e.g. IPv6 router solicitations
    if (packet[12] === 0x88 && packet[13] === 0xb5) {
      resolve(packet);
    }
  });
});

sender.write(frame);

const packet = await received;

const result = {
  received: new TextDecoder().decode(packet.subarray(14, 29)),
  receivedLength: packet.length,
  promiscuity: promiscuityOf({ interfaceName: "veth0" }),
  offloads: offloadsOf({ interfaceName: "veth0" }),
};

const closed = [receiver, sender].map((duplex) => {
  return new Promise((resolve) => {
    duplex.once("close", resolve);
    duplex.destroy();
  });
});
await Promise.all(closed);

nodeProcess.stdout.write(JSON.stringify({ ...result, promiscuityAfterClose: promiscuityOf({ interfaceName: "veth0" }) }));
