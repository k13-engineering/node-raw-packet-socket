// Runs in a network namespace with the veth pair decoy0 and decoy1: sets up
// the veth pair veth0 and veth1 in another network namespace, opens a duplex
// on each of them while briefly in there, sends a frame from veth1 to veth0
// back in its own namespace and prints what happened as JSON.
//
// decoy0 and decoy1 have the same interface indexes in their namespace as
// veth0 and veth1 in theirs, like the uplink of a host and the interfaces
// of a namespace it hands to the library.

import nodeChildProcess from "node:child_process";
import nodeFs from "node:fs";
import nodeProcess from "node:process";
import type nodeStream from "node:stream";
import { syscall, syscallNumbers } from "syscall-napi";
import { createNodeDuplexByInterfaceIndex, findInterfaceIndexByName } from "../index.ts";
import { createFrame } from "./environment.ts";

// of <linux/sched.h>
const CLONE_NEWNET = 0x40000000n;

// holds the other namespace until its stdin closes, also if this script dies
const holder = nodeChildProcess.spawn("unshare", ["--net", "sh", "-c", [
  "ip link add veth0 type veth peer name veth1",
  "ip link set veth0 up",
  "ip link set veth1 up",
  "echo ready",
  "exec cat > /dev/null",
].join(" && ")], { stdio: ["pipe", "pipe", "inherit"] });

await new Promise((resolve, reject) => {
  holder.stdout.once("data", resolve);
  holder.once("exit", () => {
    reject(Error("could not set up the other network namespace"));
  });
});

const ownNamespaceFd = nodeFs.openSync("/proc/self/ns/net", "r");
const otherNamespaceFd = nodeFs.openSync(`/proc/${holder.pid}/ns/net`, "r");

// only switches the calling thread, which is the one running JavaScript
const enterNetworkNamespace = ({ fd }: { fd: number }) => {
  const { errno } = syscall({ syscallNumber: syscallNumbers.setns, args: [BigInt(fd), CLONE_NEWNET] });
  if (errno !== undefined) {
    throw Error(`setns() failed with errno ${errno}`);
  }
};

const ifindexOf = ({ interfaceName }: { interfaceName: string }) => {
  const { error, ifindex } = findInterfaceIndexByName({ interfaceName });
  if (error !== undefined) {
    throw error;
  }
  return ifindex;
};

// the interface indexes the packet sockets of a namespace are bound to, of the Iface column
const packetSocketInterfacesOf = ({ pid }: { pid: number | string }) => {
  const lines = nodeFs.readFileSync(`/proc/${pid}/net/packet`, "utf8").trim().split("\n").slice(1);
  return lines.map((line) => {
    return Number(line.trim().split(/\s+/)[4]);
  }).toSorted((a, b) => {
    return a - b;
  });
};

const ready = ({ duplex }: { duplex: nodeStream.Duplex }) => {
  return new Promise((resolve, reject) => {
    duplex.once("ready", resolve);
    duplex.once("error", reject);
  });
};

enterNetworkNamespace({ fd: otherNamespaceFd });

const ifindexes = {
  veth0: ifindexOf({ interfaceName: "veth0" }),
  veth1: ifindexOf({ interfaceName: "veth1" }),
};
const receiver = createNodeDuplexByInterfaceIndex({ ifindex: ifindexes.veth0, ignoreOutgoingFrames: true });
const sender = createNodeDuplexByInterfaceIndex({ ifindex: ifindexes.veth1 });

enterNetworkNamespace({ fd: ownNamespaceFd });

const decoyIfindexes = {
  decoy0: ifindexOf({ interfaceName: "decoy0" }),
  decoy1: ifindexOf({ interfaceName: "decoy1" }),
};

await Promise.all([ready({ duplex: receiver }), ready({ duplex: sender })]);

const packetSocketInterfaces = {
  own: packetSocketInterfacesOf({ pid: "self" }),
  other: packetSocketInterfacesOf({ pid: holder.pid as number }),
};

// the next frame with the experimental ethertype, ignoring e.g. IPv6 router solicitations
const received = new Promise<Uint8Array>((resolve) => {
  receiver.on("data", (packet: Uint8Array) => {
    if (packet[12] === 0x88 && packet[13] === 0xb5) {
      resolve(packet);
    }
  });
});

sender.write(createFrame({ payload: "hello from veth1" }));

const packet = await received;

const closed = [receiver, sender].map((duplex) => {
  return new Promise((resolve) => {
    duplex.once("close", resolve);
    duplex.destroy();
  });
});
await Promise.all(closed);

nodeFs.closeSync(ownNamespaceFd);
nodeFs.closeSync(otherNamespaceFd);

const holderExited = new Promise((resolve) => {
  holder.once("exit", resolve);
});
holder.stdin.end();
await holderExited;

nodeProcess.stdout.write(JSON.stringify({
  ifindexes,
  decoyIfindexes,
  packetSocketInterfaces,
  received: new TextDecoder().decode(packet.subarray(14, 30)),
}));
