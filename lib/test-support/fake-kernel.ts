/* eslint-disable immutable/no-mutation, complexity, max-statements */
// A fake kernel for the unit tests. It emulates the syscalls, the memory
// pinning and the polling the API uses, with network interfaces, packet
// sockets and ethtool features, records what happens and injects errors.

import type { TLinuxKernelInterface, TSyscallResult } from "po6";
import type { TRawPacketKernelAbi } from "../kernel-abi.ts";
import type { TKernel } from "../kernel.ts";
import type { TPollEvents } from "../socket.ts";

type TFakeFeature = {
  name: string;
  active: boolean;
  // in hw_features, so it may be changed
  changeable: boolean;
  // in NETIF_F_NEVER_CHANGE
  neverChanged?: boolean;
};

type TFakeInterfaceOptions = {
  ifindex: number;
  name: string;
  features?: TFakeFeature[];
  // the interface answers ETHTOOL_GSSET_INFO without the feature string set
  hidesFeatureNames?: boolean;
};

type TFakeInterface = {
  ifindex: number;
  name: string;
  features: TFakeFeature[];
  hidesFeatureNames: boolean;
  promiscuity: number;
  sentFrames: Uint8Array[];
};

type TFakePoller = {
  armed: TPollEvents | undefined;
  closed: boolean;
};

type TFakeFile = {
  fd: number;
  domain: bigint;
  type: bigint;
  protocol: bigint;
  boundIfindex: number | undefined;
  promiscuousIfindexes: number[];
  receiveQueue: Uint8Array[];
  pollErrorCode: number | undefined;
  poller: TFakePoller | undefined;
};

type TErrnoInjection = {
  operation: string;
  errno: number;
  skip: number;
  remaining: number;
};

type TIoctlHandler = {
  name: string;
  handle: () => TSyscallResult;
};

type TCall = {
  operation: string;
  fd?: number;
  type?: bigint;
  protocol?: bigint;
  interfaceName?: string;
  membership?: { ifindex: bigint, type: bigint, alen: bigint, address: Uint8Array };
};

// netdev_features_strings of the kernel, with tx-tcp-accecn-segmentation as
// the 34th feature, so the TSO features spread over two blocks of 32 bits
const defaultFeatureNames = [
  "tx-scatter-gather", "tx-checksum-ipv4", "tx-checksum-ip-generic", "tx-checksum-ipv6", "highdma",
  "tx-scatter-gather-fraglist", "tx-vlan-hw-insert", "rx-vlan-hw-parse", "rx-vlan-filter", "vlan-challenged",
  "tx-generic-segmentation", "tx-lockless", "netns-local", "rx-gro", "rx-lro",
  "tx-tcp-segmentation", "tx-gso-robust", "tx-tcp-ecn-segmentation", "tx-tcp-mangleid-segmentation", "tx-tcp6-segmentation",
  "tx-fcoe-segmentation", "tx-gre-segmentation", "tx-gre-csum-segmentation", "tx-ipxip4-segmentation", "tx-ipxip6-segmentation",
  "tx-udp_tnl-segmentation", "tx-udp_tnl-csum-segmentation", "tx-gso-partial", "tx-tunnel-remcsum-segmentation", "tx-sctp-segmentation",
  "tx-esp-segmentation", "tx-udp-segmentation", "tx-gso-list", "tx-tcp-accecn-segmentation", "tx-checksum-fcoe-crc",
  "tx-checksum-sctp", "fcoe-mtu", "rx-ntuple-filter", "rx-hashing", "rx-checksum",
  "tx-nocache-copy", "loopback", "rx-fcs", "rx-all", "tx-vlan-stag-hw-insert",
  "rx-vlan-stag-hw-parse", "rx-vlan-stag-filter", "l2-fwd-offload", "hw-tc-offload", "esp-hw-offload",
  "esp-tx-csum-hw-offload", "rx-udp_tunnel-port-offload", "tls-hw-tx-offload", "tls-hw-rx-offload", "rx-gro-hw",
  "tls-hw-record", "rx-gro-list", "macsec-hw-offload", "rx-udp-gro-forwarding", "hsr-tag-ins-offload",
  "hsr-tag-rm-offload", "hsr-fwd-offload", "hsr-dup-offload",
];

const offloadFeatureNames = [
  "tx-generic-segmentation", "rx-gro",
  "tx-tcp-segmentation", "tx-tcp-ecn-segmentation", "tx-tcp-mangleid-segmentation", "tx-tcp6-segmentation",
  "tx-tcp-accecn-segmentation",
];

// the features the legacy flags stand for in the kernel, e.g. NETIF_F_ALL_TSO for ETHTOOL_GTSO
const legacyFlagFeatureNames: { [command: string]: string[] } = {
  ETHTOOL_GTSO: ["tx-tcp-segmentation", "tx-tcp-ecn-segmentation", "tx-tcp-mangleid-segmentation", "tx-tcp6-segmentation"],
  ETHTOOL_GGSO: ["tx-generic-segmentation"],
  ETHTOOL_GGRO: ["rx-gro"],
};

// the offload features are on and may be changed, everything else is off
const createDefaultFeatures = (): TFakeFeature[] => {
  return defaultFeatureNames.map((name) => {
    const offload = offloadFeatureNames.includes(name);
    return { name, active: offload, changeable: offload };
  });
};

const isChangeable = (feature: TFakeFeature) => {
  return feature.changeable;
};

const isActive = (feature: TFakeFeature) => {
  return feature.active;
};

const isNeverChanged = (feature: TFakeFeature) => {
  return feature.neverChanged === true;
};

const ETHTOOL_F_UNSUPPORTED = 1n;
const MSG_TRUNC = 0x20n;
const bitsPerBlock = 32;

const createFakeKernel = ({
  kernelAbi,
  interfaces: interfaceOptions = [{ ifindex: 1, name: "lo" }, { ifindex: 2, name: "eth0" }]
}: {
  kernelAbi: TRawPacketKernelAbi,
  interfaces?: TFakeInterfaceOptions[]
}) => {

  const { constants } = kernelAbi;
  const { errnoCodes } = kernelAbi.po6;

  const interfaces: TFakeInterface[] = interfaceOptions.map((options) => {
    return {
      ifindex: options.ifindex,
      name: options.name,
      features: (options.features ?? createDefaultFeatures()).map((feature) => {
        return { ...feature };
      }),
      hidesFeatureNames: options.hidesFeatureNames ?? false,
      promiscuity: 0,
      sentFrames: [],
    };
  });

  const files = new Map<number, TFakeFile>();
  let nextFd = 100;

  const pinnedBuffers = new Map<bigint, Uint8Array>();
  let nextAddress = 0x1000_0000n;

  let injections: TErrnoInjection[] = [];
  let calls: TCall[] = [];
  let violations: string[] = [];

  let sendCapacity = Infinity;
  let shortWrites = false;

  const ethtoolCommandNames = new Map<bigint, string>(Object.entries(constants).filter(([name]) => {
    return name.startsWith("ETHTOOL_");
  }).map(([name, value]) => {
    return [value, name];
  }));

  const ok = ({ ret = 0n }: { ret?: bigint } = {}): TSyscallResult => {
    return { errno: undefined, ret };
  };

  const fail = ({ errno }: { errno: number }): TSyscallResult => {
    return { errno, ret: undefined };
  };

  const record = (call: TCall) => {
    calls = [...calls, call];
  };

  // the errno to fail the operation with, if a test injected one
  const takeInjectedErrno = ({ operation }: { operation: string }) => {
    const injection = injections.find((candidate) => {
      return candidate.operation === operation && candidate.remaining > 0;
    });

    if (injection === undefined) {
      return undefined;
    }

    if (injection.skip > 0) {
      injection.skip -= 1;
      return undefined;
    }

    injection.remaining -= 1;
    return injection.errno;
  };

  const interfaceByIndex = ({ ifindex }: { ifindex: number }) => {
    return interfaces.find((candidate) => {
      return candidate.ifindex === ifindex;
    });
  };

  const interfaceByName = ({ name }: { name: string }) => {
    return interfaces.find((candidate) => {
      return candidate.name === name;
    });
  };

  // memory

  const pinBuffer: TKernel["memory"]["pinBuffer"] = ({ buffer }) => {
    const address = nextAddress;
    nextAddress += BigInt(buffer.length) + 16n;
    pinnedBuffers.set(address, buffer);

    let unpinned = false;

    return {
      address,
      unpin: () => {
        if (unpinned) {
          violations = [...violations, `buffer at 0x${address.toString(16)} unpinned twice`];
        }
        unpinned = true;
        pinnedBuffers.delete(address);
      }
    };
  };

  // polling, level-triggered like epoll and once per arming like @k13engineering/uv-poll

  const checkPollers = () => {
    files.forEach((file) => {
      const poller = file.poller;
      if (poller === undefined || poller.closed || poller.armed === undefined) {
        return;
      }

      const events = poller.armed;

      if (file.pollErrorCode !== undefined) {
        const errorCode = file.pollErrorCode;
        file.pollErrorCode = undefined;
        poller.armed = undefined;
        events.error({ errorCode });
        return;
      }

      if (events.readable !== undefined && file.receiveQueue.length > 0) {
        poller.armed = undefined;
        events.readable();
        return;
      }

      if (events.writable !== undefined && sendCapacity > 0) {
        poller.armed = undefined;
        events.writable();
      }
    });
  };

  const schedulePollerCheck = () => {
    setImmediate(checkPollers);
  };

  const createPoller: TKernel["createPoller"] = ({ fd }) => {
    const file = files.get(fd);
    if (file === undefined) {
      throw Error(`invalid file descriptor ${fd} provided to createPoller`);
    }

    const poller: TFakePoller = { armed: undefined, closed: false };
    file.poller = poller;

    const requireOpen = () => {
      if (poller.closed) {
        throw Error("already closed");
      }
    };

    return {
      armOnce: (events) => {
        requireOpen();
        if (events.readable === undefined && events.writable === undefined) {
          throw Error("at least one event must be set to arm the poller");
        }
        poller.armed = { ...events };
        schedulePollerCheck();
      },
      disarm: () => {
        requireOpen();
        poller.armed = undefined;
      },
      close: () => {
        requireOpen();
        poller.closed = true;
        poller.armed = undefined;
      }
    };
  };

  // sockets

  const socket: TLinuxKernelInterface["socket"] = ({ domain, type, protocol }) => {
    const operation = domain === constants.AF_PACKET ? "socket:AF_PACKET" : "socket:AF_INET";
    record({ operation, type, protocol });

    const errno = takeInjectedErrno({ operation });
    if (errno !== undefined) {
      return fail({ errno });
    }

    const fd = nextFd;
    nextFd += 1;

    files.set(fd, {
      fd,
      domain,
      type,
      protocol,
      boundIfindex: undefined,
      promiscuousIfindexes: [],
      receiveQueue: [],
      pollErrorCode: undefined,
      poller: undefined,
    });

    return ok({ ret: BigInt(fd) });
  };

  const close: TLinuxKernelInterface["close"] = ({ fd }) => {
    record({ operation: "close", fd });

    const file = files.get(fd);
    if (file === undefined) {
      violations = [...violations, `closed fd ${fd}, which is not open`];
      return fail({ errno: errnoCodes.EBADF });
    }

    if (file.poller !== undefined && !file.poller.closed) {
      violations = [...violations, `closed fd ${fd} while its poller is open`];
    }

    // the kernel drops the memberships of the socket
    file.promiscuousIfindexes.forEach((ifindex) => {
      const iface = interfaceByIndex({ ifindex });
      if (iface !== undefined) {
        iface.promiscuity -= 1;
      }
    });

    files.delete(fd);

    const errno = takeInjectedErrno({ operation: "close" });
    return errno === undefined ? ok() : fail({ errno });
  };

  const fileOf = ({ fd }: { fd: number }) => {
    const file = files.get(fd);
    if (file === undefined) {
      violations = [...violations, `syscall on fd ${fd}, which is not open`];
    }
    return file;
  };

  const bind: TLinuxKernelInterface["bind"] = ({ fd, sockaddr }) => {
    record({ operation: "bind", fd });

    const file = fileOf({ fd });
    if (file === undefined) {
      return fail({ errno: errnoCodes.EBADF });
    }

    const errno = takeInjectedErrno({ operation: "bind" });
    if (errno !== undefined) {
      return fail({ errno });
    }

    const { sll_family, sll_protocol, sll_ifindex } = kernelAbi.sockaddr_ll.parse({ data: sockaddr });

    if (sll_family !== constants.AF_PACKET || sll_protocol !== constants.ETH_P_ALL) {
      return fail({ errno: errnoCodes.EINVAL });
    }

    if (interfaceByIndex({ ifindex: Number(sll_ifindex) }) === undefined) {
      return fail({ errno: errnoCodes.ENODEV });
    }

    file.boundIfindex = Number(sll_ifindex);

    return ok();
  };

  const setsockopt: TLinuxKernelInterface["setsockopt"] = ({ fd, level, optname, optval }) => {
    record({ operation: "setsockopt", fd });

    const file = fileOf({ fd });
    if (file === undefined) {
      return fail({ errno: errnoCodes.EBADF });
    }

    const errno = takeInjectedErrno({ operation: "setsockopt" });
    if (errno !== undefined) {
      return fail({ errno });
    }

    if (level !== kernelAbi.po6.constants.SOL_PACKET || optname !== kernelAbi.po6.constants.PACKET_ADD_MEMBERSHIP) {
      return fail({ errno: errnoCodes.ENOPROTOOPT });
    }

    const { mr_ifindex, mr_type, mr_alen, mr_address } = kernelAbi.packet_mreq.parse({ data: optval });
    record({
      operation: "PACKET_ADD_MEMBERSHIP",
      fd,
      membership: { ifindex: mr_ifindex, type: mr_type, alen: mr_alen, address: mr_address }
    });

    const iface = interfaceByIndex({ ifindex: Number(mr_ifindex) });

    if (iface === undefined) {
      return fail({ errno: errnoCodes.ENODEV });
    }

    if (mr_type !== kernelAbi.po6.constants.PACKET_MR_PROMISC) {
      return fail({ errno: errnoCodes.EINVAL });
    }

    iface.promiscuity += 1;
    file.promiscuousIfindexes = [...file.promiscuousIfindexes, iface.ifindex];

    return ok();
  };

  // the single data buffer po6 passes in struct msghdr
  const messageDataOf = ({ msghdr }: { msghdr: Uint8Array }) => {
    const header = kernelAbi.po6.msghdr.parse({ data: msghdr });
    const iovecBuffer = pinnedBuffers.get(header.msg_iov);

    if (iovecBuffer === undefined || header.msg_iovlen !== 1n) {
      return undefined;
    }

    const { iov_base, iov_len } = kernelAbi.po6.iovec.parse({ data: iovecBuffer });
    const data = pinnedBuffers.get(iov_base);

    if (data === undefined || BigInt(data.length) !== iov_len) {
      return undefined;
    }

    return { header, data };
  };

  const recvmsg: TLinuxKernelInterface["recvmsg"] = ({ fd, msghdr }) => {
    record({ operation: "recvmsg", fd });

    const file = fileOf({ fd });
    if (file === undefined) {
      return fail({ errno: errnoCodes.EBADF });
    }

    const errno = takeInjectedErrno({ operation: "recvmsg" });
    if (errno !== undefined) {
      return fail({ errno });
    }

    const message = messageDataOf({ msghdr });
    if (message === undefined) {
      return fail({ errno: errnoCodes.EFAULT });
    }

    if (file.receiveQueue.length === 0) {
      return fail({ errno: errnoCodes.EAGAIN });
    }

    const [frame, ...rest] = file.receiveQueue;
    file.receiveQueue = rest;

    const bytesReceived = Math.min(frame.length, message.data.length);
    message.data.set(frame.subarray(0, bytesReceived));

    msghdr.set(kernelAbi.po6.msghdr.format({
      value: {
        ...message.header,
        msg_flags: frame.length > message.data.length ? MSG_TRUNC : 0n
      }
    }));

    return ok({ ret: BigInt(bytesReceived) });
  };

  const sendmsg: TLinuxKernelInterface["sendmsg"] = ({ fd, msghdr }) => {
    record({ operation: "sendmsg", fd });

    const file = fileOf({ fd });
    if (file === undefined) {
      return fail({ errno: errnoCodes.EBADF });
    }

    const errno = takeInjectedErrno({ operation: "sendmsg" });
    if (errno !== undefined) {
      return fail({ errno });
    }

    const message = messageDataOf({ msghdr });
    if (message === undefined) {
      return fail({ errno: errnoCodes.EFAULT });
    }

    const iface = interfaceByIndex({ ifindex: file.boundIfindex ?? -1 });
    if (iface === undefined) {
      return fail({ errno: errnoCodes.ENXIO });
    }

    if (sendCapacity <= 0) {
      return fail({ errno: errnoCodes.EAGAIN });
    }

    sendCapacity -= 1;

    const bytesSent = shortWrites ? message.data.length - 1 : message.data.length;
    // a plain copy, data may be a Buffer
    iface.sentFrames = [...iface.sentFrames, Uint8Array.from(message.data.subarray(0, bytesSent))];

    return ok({ ret: BigInt(bytesSent) });
  };

  // ioctls

  const ifruOf = ({ ifr }: { ifr: Uint8Array }) => {
    return kernelAbi.ifreq.parse({ data: ifr });
  };

  const writeIfreq = ({ ifr, interfaceName, ifru }: { ifr: Uint8Array, interfaceName: string, ifru: Uint8Array }) => {
    const ifr_ifru = new Uint8Array(kernelAbi.ifmap.size);
    ifr_ifru.set(ifru);
    ifr.set(kernelAbi.ifreq.format({ value: { ifr_name: interfaceName, ifr_ifru } }));
  };

  const siocgifindex = ({ ifr }: { ifr: Uint8Array }) => {
    const { ifr_name, ifr_ifru } = ifruOf({ ifr });
    const iface = interfaceByName({ name: ifr_name });

    if (iface === undefined) {
      return fail({ errno: errnoCodes.ENODEV });
    }

    // the kernel copies the whole ifreq back, with ifr_ifindex set
    const ifru = ifr_ifru.slice();
    ifru.set(kernelAbi.ifru_ifindex.format({ value: { ifr_ifindex: BigInt(iface.ifindex) } }));
    writeIfreq({ ifr, interfaceName: ifr_name, ifru });

    return ok();
  };

  const siocgifname = ({ ifr }: { ifr: Uint8Array }) => {
    const { ifr_ifru } = ifruOf({ ifr });
    const { ifr_ifindex } = kernelAbi.ifru_ifindex.parse({ data: ifr_ifru });
    const iface = interfaceByIndex({ ifindex: Number(ifr_ifindex) });

    if (iface === undefined) {
      return fail({ errno: errnoCodes.ENODEV });
    }

    writeIfreq({ ifr, interfaceName: iface.name, ifru: ifr_ifru });

    return ok();
  };

  const featureBits = ({ iface, select }: { iface: TFakeInterface, select: (feature: TFakeFeature) => boolean }) => {
    return iface.features.reduce((bits, feature, index) => {
      return select(feature) ? bits | (1n << BigInt(index)) : bits;
    }, 0n);
  };

  const blockCountOf = ({ iface }: { iface: TFakeInterface }) => {
    return Math.ceil(iface.features.length / bitsPerBlock);
  };

  const blockOf = ({ bits, index }: { bits: bigint, index: number }) => {
    return BigInt.asUintN(bitsPerBlock, bits >> BigInt(index * bitsPerBlock));
  };

  const ethtoolGssetInfo = ({ iface, data }: { iface: TFakeInterface, data: Uint8Array }) => {
    const { sset_mask } = kernelAbi.ethtool_sset_info.parse({ data });
    const featuresMask = 1n << constants.ETH_SS_FEATURES;
    const known = (sset_mask & featuresMask) !== 0n && !iface.hidesFeatureNames;

    data.set(kernelAbi.ethtool_sset_info.format({
      value: { cmd: constants.ETHTOOL_GSSET_INFO, reserved: 0n, sset_mask: known ? featuresMask : 0n }
    }));

    if (known) {
      data.set(
        kernelAbi.ethtool_sset_length.format({ value: { length: BigInt(iface.features.length) } }),
        kernelAbi.ethtool_sset_info.size
      );
    }

    return ok();
  };

  const ethtoolGstrings = ({ iface, data }: { iface: TFakeInterface, data: Uint8Array }) => {
    const { string_set } = kernelAbi.ethtool_gstrings.parse({ data });
    if (string_set !== constants.ETH_SS_FEATURES) {
      return fail({ errno: errnoCodes.EOPNOTSUPP });
    }

    const headerSize = kernelAbi.ethtool_gstrings.size;
    const entrySize = kernelAbi.ethtool_gstring.size;

    // the kernel writes as many strings as there are, whatever len says
    if (data.length < headerSize + iface.features.length * entrySize) {
      return fail({ errno: errnoCodes.EFAULT });
    }

    data.set(kernelAbi.ethtool_gstrings.format({
      value: { cmd: constants.ETHTOOL_GSTRINGS, string_set, len: BigInt(iface.features.length) }
    }));

    iface.features.forEach((feature, index) => {
      data.set(kernelAbi.ethtool_gstring.format({ value: { string: feature.name } }), headerSize + index * entrySize);
    });

    return ok();
  };

  const ethtoolGfeatures = ({ iface, data }: { iface: TFakeInterface, data: Uint8Array }) => {
    const { size } = kernelAbi.ethtool_gfeatures.parse({ data });
    const blockCount = blockCountOf({ iface });
    const copyCount = Math.min(Number(size), blockCount);
    const headerSize = kernelAbi.ethtool_gfeatures.size;
    const blockSize = kernelAbi.ethtool_get_features_block.size;

    if (data.length < headerSize + copyCount * blockSize) {
      return fail({ errno: errnoCodes.EFAULT });
    }

    const available = featureBits({ iface, select: isChangeable });
    const active = featureBits({ iface, select: isActive });
    const neverChanged = featureBits({ iface, select: isNeverChanged });

    data.set(kernelAbi.ethtool_gfeatures.format({ value: { cmd: constants.ETHTOOL_GFEATURES, size: BigInt(blockCount) } }));

    Array.from({ length: copyCount }).forEach((_, index) => {
      data.set(kernelAbi.ethtool_get_features_block.format({
        value: {
          available: blockOf({ bits: available, index }),
          // the fake keeps no wanted features apart from the active ones
          requested: blockOf({ bits: active, index }),
          active: blockOf({ bits: active, index }),
          never_changed: blockOf({ bits: neverChanged, index }),
        }
      }), headerSize + index * blockSize);
    });

    return ok();
  };

  // like ethtool_set_features() in net/ethtool/ioctl.c
  const ethtoolSfeatures = ({ iface, data }: { iface: TFakeInterface, data: Uint8Array }) => {
    const { size } = kernelAbi.ethtool_sfeatures.parse({ data });
    const blockCount = blockCountOf({ iface });

    if (Number(size) !== blockCount) {
      return fail({ errno: errnoCodes.EINVAL });
    }

    const headerSize = kernelAbi.ethtool_sfeatures.size;
    const blockSize = kernelAbi.ethtool_set_features_block.size;

    const blocks = Array.from({ length: blockCount }).map((_, index) => {
      return kernelAbi.ethtool_set_features_block.parse({ data: data.subarray(headerSize + index * blockSize) });
    });

    const bitsOf = ({ field }: { field: "valid" | "requested" }) => {
      return blocks.reduce((bits, block, index) => {
        return bits | (block[field] << BigInt(index * bitsPerBlock));
      }, 0n);
    };

    const requestedValid = bitsOf({ field: "valid" });
    const requested = bitsOf({ field: "requested" });
    const changeable = featureBits({ iface, select: isChangeable });
    const valid = requestedValid & changeable;

    iface.features.forEach((feature, index) => {
      const bit = 1n << BigInt(index);
      if ((valid & bit) !== 0n) {
        feature.active = (requested & bit) !== 0n;
      }
    });

    return ok({ ret: (requestedValid & ~changeable) === 0n ? 0n : ETHTOOL_F_UNSUPPORTED });
  };

  const ethtoolLegacyFlag = ({ iface, data, commandName }: { iface: TFakeInterface, data: Uint8Array, commandName: string }) => {
    const { cmd } = kernelAbi.ethtool_value.parse({ data });
    const names = legacyFlagFeatureNames[commandName];
    const on = iface.features.some((feature) => {
      return feature.active && names.includes(feature.name);
    });

    data.set(kernelAbi.ethtool_value.format({ value: { cmd, data: on ? 1n : 0n } }));

    return ok();
  };

  const siocethtool = ({ ifr }: { ifr: Uint8Array }) => {
    const { ifr_name, ifr_ifru } = ifruOf({ ifr });
    const { ifr_data } = kernelAbi.ifru_data.parse({ data: ifr_ifru });

    // the kernel reads the command from user memory, which must be pinned
    const data = pinnedBuffers.get(ifr_data);
    if (data === undefined) {
      return fail({ errno: errnoCodes.EFAULT });
    }

    const { cmd } = kernelAbi.ethtool_value.parse({ data });
    const commandName = ethtoolCommandNames.get(cmd) ?? `ethtool command 0x${cmd.toString(16)}`;
    record({ operation: commandName, interfaceName: ifr_name });

    const errno = takeInjectedErrno({ operation: commandName });
    if (errno !== undefined) {
      return fail({ errno });
    }

    const iface = interfaceByName({ name: ifr_name });
    if (iface === undefined) {
      return fail({ errno: errnoCodes.ENODEV });
    }

    const handlers: { [name: string]: () => TSyscallResult } = {
      ETHTOOL_GSSET_INFO: () => {
        return ethtoolGssetInfo({ iface, data });
      },
      ETHTOOL_GSTRINGS: () => {
        return ethtoolGstrings({ iface, data });
      },
      ETHTOOL_GFEATURES: () => {
        return ethtoolGfeatures({ iface, data });
      },
      ETHTOOL_SFEATURES: () => {
        return ethtoolSfeatures({ iface, data });
      },
      ETHTOOL_GTSO: () => {
        return ethtoolLegacyFlag({ iface, data, commandName });
      },
      ETHTOOL_GGSO: () => {
        return ethtoolLegacyFlag({ iface, data, commandName });
      },
      ETHTOOL_GGRO: () => {
        return ethtoolLegacyFlag({ iface, data, commandName });
      },
    };

    const handler = handlers[commandName];
    return handler === undefined ? fail({ errno: errnoCodes.EOPNOTSUPP }) : handler();
  };

  const ioctl: TLinuxKernelInterface["ioctl"] = ({ fd, request, args }) => {
    const [ifr] = args;

    const file = fileOf({ fd });
    if (file === undefined) {
      return fail({ errno: errnoCodes.EBADF });
    }

    if (!(ifr instanceof Uint8Array) || ifr.length < kernelAbi.ifreq.size) {
      return fail({ errno: errnoCodes.EFAULT });
    }

    const handlers = new Map<bigint, TIoctlHandler>([
      [constants.SIOCGIFINDEX, {
        name: "SIOCGIFINDEX",
        handle: () => {
          return siocgifindex({ ifr });
        }
      }],
      [constants.SIOCGIFNAME, {
        name: "SIOCGIFNAME",
        handle: () => {
          return siocgifname({ ifr });
        }
      }],
      [constants.SIOCETHTOOL, {
        name: "SIOCETHTOOL",
        handle: () => {
          return siocethtool({ ifr });
        }
      }],
    ]);

    const handler = handlers.get(request);
    if (handler === undefined) {
      return fail({ errno: errnoCodes.ENOTTY });
    }

    record({ operation: handler.name, fd });

    const errno = takeInjectedErrno({ operation: handler.name });
    if (errno !== undefined) {
      return fail({ errno });
    }

    return handler.handle();
  };

  const notImplemented = (): TSyscallResult => {
    return fail({ errno: errnoCodes.ENOSYS });
  };

  const kernelInterface: TLinuxKernelInterface = {
    read: notImplemented,
    write: notImplemented,
    close,
    dup: notImplemented,
    ioctl,
    eventfd2: notImplemented,
    socket,
    bind,
    getsockname: notImplemented,
    recvmsg,
    sendmsg,
    shutdown: notImplemented,
    getsockopt: notImplemented,
    setsockopt,
  };

  const kernel: TKernel = {
    kernelInterface,
    memory: { pinBuffer },
    createPoller,
  };

  // test controls

  const injectErrno = ({ operation, errno, skip = 0, count = 1 }: { operation: string, errno: number, skip?: number, count?: number }) => {
    injections = [...injections, { operation, errno, skip, remaining: count }];
  };

  const packetSocketsOn = ({ ifindex }: { ifindex: number }) => {
    return [...files.values()].filter((file) => {
      return file.domain === constants.AF_PACKET && file.boundIfindex === ifindex;
    });
  };

  // a frame arrives on the interface
  const receiveFrame = ({ ifindex, frame }: { ifindex: number, frame: Uint8Array }) => {
    packetSocketsOn({ ifindex }).forEach((file) => {
      file.receiveQueue = [...file.receiveQueue, frame];
    });
    schedulePollerCheck();
  };

  // the error that polling the packet sockets of the interface reports next
  const failPolling = ({ ifindex, errorCode }: { ifindex: number, errorCode: number }) => {
    packetSocketsOn({ ifindex }).forEach((file) => {
      file.pollErrorCode = errorCode;
    });
    schedulePollerCheck();
  };

  // the number of frames sendmsg() takes before it fails with EAGAIN
  const setSendCapacity = ({ frames }: { frames: number }) => {
    sendCapacity = frames;
    schedulePollerCheck();
  };

  const setShortWrites = ({ enabled }: { enabled: boolean }) => {
    shortWrites = enabled;
  };

  const interfaceState = ({ name }: { name: string }) => {
    const iface = interfaceByName({ name });
    if (iface === undefined) {
      throw Error(`no fake interface ${name}`);
    }

    return {
      promiscuity: iface.promiscuity,
      sentFrames: iface.sentFrames,
      activeFeatures: iface.features.filter((feature) => {
        return feature.active;
      }).map((feature) => {
        return feature.name;
      })
    };
  };

  const pollerOf = ({ fd }: { fd: number }) => {
    return files.get(fd)?.poller;
  };

  return {
    kernel,

    injectErrno,
    receiveFrame,
    failPolling,
    setSendCapacity,
    setShortWrites,

    interfaceState,
    pollerOf,
    calls: () => {
      return calls;
    },
    openFds: () => {
      return [...files.keys()];
    },
    pinnedBufferCount: () => {
      return pinnedBuffers.size;
    },
    violations: () => {
      return violations;
    },
  };
};

type TFakeKernel = ReturnType<typeof createFakeKernel>;

export type {
  TFakeFeature,
  TFakeKernel
};

export {
  createFakeKernel,
  createDefaultFeatures,
  defaultFeatureNames
};
