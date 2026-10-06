# node-raw-packet-socket

Raw `AF_PACKET` sockets for Node.js on Linux, as duplex streams of ethernet frames, written in TypeScript.

- **Streams.** Every chunk you read is one frame received on the interface, every chunk you write is sent as one frame.
- **No external tools.** Offloads are disabled with `SIOCETHTOOL` ioctls the way `ethtool -K` does it, not by running `ethtool`.
- **Errors are events.** Problems with opening the socket or with the interface are emitted as `"error"` on the stream.

## Requirements

- Linux on x86_64 or arm64
- Node.js 24 or newer
- `CAP_NET_RAW` to open packet sockets, and `CAP_NET_ADMIN` to disable offloads

## Installation

```sh
npm install @k13engineering/raw-packet-socket
```

## Usage

```ts
import {
  createNodeDuplexByInterfaceIndex,
  disableOffloadsUntilReboot,
  findInterfaceIndexByName
} from "@k13engineering/raw-packet-socket";

const { error, ifindex } = findInterfaceIndexByName({ interfaceName: "eth0" });
if (error !== undefined) {
  throw error;
}

const duplex = createNodeDuplexByInterfaceIndex({
  ifindex,
  // receive frames the way they are on the wire instead of merged by the kernel
  disableGenericReceiveOffloadUntilReboot: true,
  // also receive frames addressed to other hosts
  enablePromiscuousMode: true,
});

duplex.on("error", (err) => {
  console.error(err);
});

duplex.on("data", (frame: Buffer) => {
  console.log(frame);
});

// broadcast, from a locally administered address, with an experimental ethertype
const frame = new Uint8Array(60);
frame.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02, 0, 0, 0, 0, 0x01, 0x88, 0xb5]);
duplex.write(frame);
```

`findInterfaceIndexByName()` returns `{ error, ifindex }` instead of throwing.

`createNodeDuplexByInterfaceIndex()` returns the stream right away and opens the socket in another task. Once it is set up, the stream emits `"open"` and `"ready"`. Destroy the stream to close the socket. Ending it is an error, as an ethernet interface cannot be half-closed.

The options are:

| Option | Effect |
| --- | --- |
| `disableTcpSegmentationOffloadUntilReboot` | like `ethtool -K <interface> tso off` |
| `disableGenericSegmentationOffloadUntilReboot` | like `ethtool -K <interface> gso off` |
| `disableGenericReceiveOffloadUntilReboot` | like `ethtool -K <interface> gro off` |
| `disableHardwareGenericReceiveOffloadUntilReboot` | like `ethtool -K <interface> rx-gro-hw off` |
| `disableLargeReceiveOffloadUntilReboot` | like `ethtool -K <interface> lro off` |
| `disableUdpSegmentationOffloadUntilReboot` | like `ethtool -K <interface> tx-udp-segmentation off` |
| `disableTransmitChecksumOffloadUntilReboot` | like `ethtool -K <interface> tx off` |
| `enablePromiscuousMode` | `PACKET_MR_PROMISC` membership for as long as the socket is open |
| `ignoreOutgoingFrames` | `PACKET_IGNORE_OUTGOING`, only receive the frames arriving on the interface, Linux 4.20 or newer |

Besides the frames arriving on the interface, the stream receives the frames the host sends on it, except the ones written to the stream itself. `ignoreOutgoingFrames` leaves them out.

The receive offloads merge frames before the socket sees them. The transmit offloads leave the outgoing frames of the host unfinished where the socket sees them: oversized with segmentation offloads, with unfinished checksums with checksum offload. Turning off checksum offload makes the kernel turn off TCP and UDP segmentation offload as well.

The offloads stay disabled until the interface goes away, e.g. on reboot. Like `ethtool`, the ioctls address the interface by name, so renaming it while the socket is set up affects the wrong interface or fails.

The stream reports the interface going down as `Error("interface went down")`.

`disableOffloadsUntilReboot()` disables offloads of an interface without opening a socket on it. On a macvlan interface, for example, the frames are merged on its parent already:

```ts
const { error } = disableOffloadsUntilReboot({
  ifindex: parentIfindex,
  offloads: ["generic-receive-offload", "rx-gro-hw", "large-receive-offload"],
});
```

It takes the names `ethtool -k` shows: `tx-checksumming`, `tcp-segmentation-offload`, `tx-udp-segmentation`, `generic-segmentation-offload`, `generic-receive-offload`, `rx-gro-hw` and `large-receive-offload`. Like `findInterfaceIndexByName()`, it returns `{ error }` instead of throwing.

## How it works

The library performs the syscalls with [po6](https://www.npmjs.com/package/po6) and [syscall-napi](https://www.npmjs.com/package/syscall-napi), pins buffers handed to the kernel with [buffer2address](https://www.npmjs.com/package/buffer2address), and waits for the socket in the event loop with [@k13engineering/uv-poll](https://www.npmjs.com/package/@k13engineering/uv-poll). The kernel structures are described with [ya-struct](https://www.npmjs.com/package/ya-struct) and compared with the C headers in the tests.

Disabling an offload works like `do_sfeatures()` in ethtool without netlink. It reads the feature names and their state, turns off the features matching the offload (e.g. `tx-checksum-*` or `tx-tcp*-segmentation`) that the device allows changing, and only fails if nothing changed while the offload is still on. Whether it is on comes from its legacy flag, e.g. `ETHTOOL_GTSO`, or from its features for `rx-gro-hw` and `tx-udp-segmentation`, which have none.

## Development

```sh
npm ci
npm run build       # transpile to dist/
npm run type-check
npm run test        # mocha with c8, 100% coverage required
npm run lint
```

`createRawPacketSocketApi()` in `lib/raw-packet-socket-api.ts` gets the kernel passed in, `index.ts` passes the one of the host (`lib/kernel.ts`). The kernel consists of the syscalls, the pinning of buffers and the polling of file descriptors.

The unit tests run against a fake kernel from `lib/test-support/`, which emulates interfaces, packet sockets and ethtool features. Some specs use the real kernel instead:

- `lib/kernel-abi.spec.ts` compiles C programs to compare the structures and constants with the headers, so it needs `gcc` and the kernel headers
- `lib/kernel.spec.ts` and `lib/index.spec.ts` use unprivileged syscalls of the host
- `lib/build.spec.ts` builds the package and type-checks a consumer against its declarations
- `lib/end-to-end.spec.ts` exchanges frames over a veth pair in a user and network namespace of its own. It needs `unshare` and `ip`, and skips where unprivileged user namespaces are not allowed.

## License

LGPL-2.1, see [LICENSE](LICENSE).
