import * as po6 from "po6";
import { define, types, type TAbi } from "ya-struct";

const int = {
  type: "c-type",
  cType: "int",
  fixedAbi: {}
} as const;

const unsignedShort = {
  type: "c-type",
  cType: "unsigned short",
  fixedAbi: {}
} as const;

const unsignedChar = {
  type: "c-type",
  cType: "unsigned char",
  fixedAbi: {}
} as const;

const unsignedLong = {
  type: "c-type",
  cType: "unsigned long",
  fixedAbi: {}
} as const;

const UInt32 = {
  type: "integer",
  sizeInBits: 32,
  signed: false,
  fixedAbi: {}
} as const;

// __be16, e.g. an ethertype
const BigEndianUInt16 = {
  type: "integer",
  sizeInBits: 16,
  signed: false,
  fixedAbi: { endianness: "big" }
} as const;

const IFNAMSIZ = 16;

// struct sockaddr_ll from <linux/if_packet.h>
const sockaddr_ll = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "sll_family", definition: unsignedShort },
      { name: "sll_protocol", definition: BigEndianUInt16 },
      { name: "sll_ifindex", definition: int },
      { name: "sll_hatype", definition: unsignedShort },
      { name: "sll_pkttype", definition: unsignedChar },
      { name: "sll_halen", definition: unsignedChar },
      { name: "sll_addr", definition: types.blob({ sizeInBytes: 8 }) },
    ]
  }
});

// struct packet_mreq from <linux/if_packet.h>
const packet_mreq = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "mr_ifindex", definition: int },
      { name: "mr_type", definition: unsignedShort },
      { name: "mr_alen", definition: unsignedShort },
      { name: "mr_address", definition: types.blob({ sizeInBytes: 8 }) },
    ]
  }
});

// struct ifmap from <net/if.h>, the largest member of the union ifr_ifru in
// struct ifreq, so it determines the size of the union
const ifmap = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "mem_start", definition: unsignedLong },
      { name: "mem_end", definition: unsignedLong },
      { name: "base_addr", definition: unsignedShort },
      { name: "irq", definition: unsignedChar },
      { name: "dma", definition: unsignedChar },
      { name: "port", definition: unsignedChar },
    ]
  }
});

// struct ifreq from <net/if.h>; the union ifr_ifru is a blob, its members
// are formatted and parsed with the ifru_* structures below
const defineIfreq = ({ machineAbi }: { machineAbi: TAbi }) => {
  return define({
    definition: {
      type: "struct",
      packed: false,
      fixedAbi: {},
      fields: [
        { name: "ifr_name", definition: types.ascii({ length: IFNAMSIZ }) },
        { name: "ifr_ifru", definition: types.blob({ sizeInBytes: ifmap.parser({ abi: machineAbi }).size }) },
      ]
    }
  });
};

// int ifr_ifindex, member of the union ifr_ifru
const ifru_ifindex = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "ifr_ifindex", definition: int },
    ]
  }
});

// void *ifr_data, member of the union ifr_ifru
const ifru_data = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "ifr_data", definition: types.pointer },
    ]
  }
});

// struct ethtool_value from <linux/ethtool.h>
const ethtool_value = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "cmd", definition: UInt32 },
      { name: "data", definition: UInt32 },
    ]
  }
});

// Linux shares these values between x86, arm and arm64
const constants = {
  AF_INET: 2n,
  AF_PACKET: 17n,

  SOCK_DGRAM: 2n,
  SOCK_RAW: 3n,
  SOCK_NONBLOCK: 0o4000n,
  SOCK_CLOEXEC: 0o2000000n,

  ETH_P_ALL: 0x0003n,

  SIOCGIFNAME: 0x8910n,
  SIOCGIFINDEX: 0x8933n,
  SIOCETHTOOL: 0x8946n,

  ETHTOOL_GTSO: 0x1en,
  ETHTOOL_STSO: 0x1fn,
  ETHTOOL_GGSO: 0x23n,
  ETHTOOL_SGSO: 0x24n,
  ETHTOOL_GGRO: 0x2bn,
  ETHTOOL_SGRO: 0x2cn,
} as const;

const createKernelAbiFor = ({ machineAbi }: { machineAbi: TAbi }) => {
  return {
    // msghdr, iovec, socklen, constants and errno values of po6
    po6: po6.createKernelAbiFor({ machineAbi }),

    sockaddr_ll: sockaddr_ll.parser({ abi: machineAbi }),
    packet_mreq: packet_mreq.parser({ abi: machineAbi }),
    ifmap: ifmap.parser({ abi: machineAbi }),
    ifreq: defineIfreq({ machineAbi }).parser({ abi: machineAbi }),
    ifru_ifindex: ifru_ifindex.parser({ abi: machineAbi }),
    ifru_data: ifru_data.parser({ abi: machineAbi }),
    ethtool_value: ethtool_value.parser({ abi: machineAbi }),
    constants,
  };
};

type TRawPacketKernelAbi = ReturnType<typeof createKernelAbiFor>;

export type {
  TRawPacketKernelAbi
};

export {
  createKernelAbiFor,
  constants,
  defineIfreq,
  sockaddr_ll,
  packet_mreq,
  ifmap,
  ifru_ifindex,
  ifru_data,
  ethtool_value,
};
