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

const UInt16 = {
  type: "integer",
  sizeInBits: 16,
  signed: false,
  fixedAbi: {}
} as const;

const UInt32 = {
  type: "integer",
  sizeInBits: 32,
  signed: false,
  fixedAbi: {}
} as const;

const UInt64 = {
  type: "integer",
  sizeInBits: 64,
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
const ETH_GSTRING_LEN = 32;

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

// the int most socket options take
const sockopt_int = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "value", definition: int },
    ]
  }
});

// struct tpacket_auxdata from <linux/if_packet.h>
const tpacket_auxdata = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "tp_status", definition: UInt32 },
      { name: "tp_len", definition: UInt32 },
      { name: "tp_snaplen", definition: UInt32 },
      { name: "tp_mac", definition: UInt16 },
      { name: "tp_net", definition: UInt16 },
      { name: "tp_vlan_tci", definition: UInt16 },
      { name: "tp_vlan_tpid", definition: UInt16 },
    ]
  }
});

// struct cmsghdr from <sys/socket.h>, with cmsg_len as size_t, which has
// the size of unsigned long on LP64 and ILP32, like in po6
const cmsghdr = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "cmsg_len", definition: unsignedLong },
      { name: "cmsg_level", definition: int },
      { name: "cmsg_type", definition: int },
    ]
  }
});

// size_t, to which control messages are aligned
const size_t = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "value", definition: unsignedLong },
    ]
  }
});

// the 802.1Q tag between the source address and the ethertype of a frame
const vlan_tag = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "tpid", definition: BigEndianUInt16 },
      { name: "tci", definition: BigEndianUInt16 },
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

// struct ethtool_sset_info from <linux/ethtool.h>, followed by the flexible
// array data of ethtool_sset_length entries
const ethtool_sset_info = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "cmd", definition: UInt32 },
      { name: "reserved", definition: UInt32 },
      { name: "sset_mask", definition: UInt64 },
    ]
  }
});

// an entry of ethtool_sset_info.data, the length of a string set
const ethtool_sset_length = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "length", definition: UInt32 },
    ]
  }
});

// struct ethtool_gstrings from <linux/ethtool.h>, followed by the flexible
// array data of ethtool_gstring entries
const ethtool_gstrings = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "cmd", definition: UInt32 },
      { name: "string_set", definition: UInt32 },
      { name: "len", definition: UInt32 },
    ]
  }
});

// an entry of ethtool_gstrings.data, a string of ETH_GSTRING_LEN bytes
const ethtool_gstring = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "string", definition: types.ascii({ length: ETH_GSTRING_LEN }) },
    ]
  }
});

// struct ethtool_gfeatures from <linux/ethtool.h>, followed by the flexible
// array features of struct ethtool_get_features_block
const ethtool_gfeatures = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "cmd", definition: UInt32 },
      { name: "size", definition: UInt32 },
    ]
  }
});

// struct ethtool_get_features_block from <linux/ethtool.h>
const ethtool_get_features_block = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "available", definition: UInt32 },
      { name: "requested", definition: UInt32 },
      { name: "active", definition: UInt32 },
      { name: "never_changed", definition: UInt32 },
    ]
  }
});

// struct ethtool_sfeatures from <linux/ethtool.h>, followed by the flexible
// array features of struct ethtool_set_features_block
const ethtool_sfeatures = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "cmd", definition: UInt32 },
      { name: "size", definition: UInt32 },
    ]
  }
});

// struct ethtool_set_features_block from <linux/ethtool.h>
const ethtool_set_features_block = define({
  definition: {
    type: "struct",
    packed: false,
    fixedAbi: {},
    fields: [
      { name: "valid", definition: UInt32 },
      { name: "requested", definition: UInt32 },
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

  PACKET_AUXDATA: 8n,
  PACKET_IGNORE_OUTGOING: 23n,

  TP_STATUS_VLAN_VALID: 0x10n,

  SIOCGIFNAME: 0x8910n,
  SIOCGIFINDEX: 0x8933n,
  SIOCETHTOOL: 0x8946n,

  ETHTOOL_GTXCSUM: 0x16n,
  ETHTOOL_GSTRINGS: 0x1bn,
  ETHTOOL_GTSO: 0x1en,
  ETHTOOL_GGSO: 0x23n,
  ETHTOOL_GFLAGS: 0x25n,
  ETHTOOL_GGRO: 0x2bn,
  ETHTOOL_GSSET_INFO: 0x37n,
  ETHTOOL_GFEATURES: 0x3an,
  ETHTOOL_SFEATURES: 0x3bn,

  ETH_SS_FEATURES: 4n,
  ETH_FLAG_LRO: 0x8000n,
} as const;

// CMSG_ALIGN(), CMSG_LEN(), CMSG_SPACE() and CMSG_DATA() of <sys/socket.h>
const createControlMessageLayoutFor = ({ machineAbi }: { machineAbi: TAbi }) => {
  const alignment = size_t.parser({ abi: machineAbi }).size;

  const align = ({ length }: { length: number }) => {
    return Math.ceil(length / alignment) * alignment;
  };

  // the offset of the data in a control message
  const dataOffset = align({ length: cmsghdr.parser({ abi: machineAbi }).size });

  return {
    dataOffset,
    lengthFor: ({ dataLength }: { dataLength: number }) => {
      return dataOffset + dataLength;
    },
    spaceFor: ({ dataLength }: { dataLength: number }) => {
      return dataOffset + align({ length: dataLength });
    },
  };
};

const createKernelAbiFor = ({ machineAbi }: { machineAbi: TAbi }) => {
  return {
    // msghdr, iovec, socklen, constants and errno values of po6
    po6: po6.createKernelAbiFor({ machineAbi }),

    sockaddr_ll: sockaddr_ll.parser({ abi: machineAbi }),
    sockopt_int: sockopt_int.parser({ abi: machineAbi }),
    packet_mreq: packet_mreq.parser({ abi: machineAbi }),
    tpacket_auxdata: tpacket_auxdata.parser({ abi: machineAbi }),
    cmsghdr: cmsghdr.parser({ abi: machineAbi }),
    controlMessageLayout: createControlMessageLayoutFor({ machineAbi }),
    vlan_tag: vlan_tag.parser({ abi: machineAbi }),
    ifmap: ifmap.parser({ abi: machineAbi }),
    ifreq: defineIfreq({ machineAbi }).parser({ abi: machineAbi }),
    ifru_ifindex: ifru_ifindex.parser({ abi: machineAbi }),
    ifru_data: ifru_data.parser({ abi: machineAbi }),
    ethtool_value: ethtool_value.parser({ abi: machineAbi }),
    ethtool_sset_info: ethtool_sset_info.parser({ abi: machineAbi }),
    ethtool_sset_length: ethtool_sset_length.parser({ abi: machineAbi }),
    ethtool_gstrings: ethtool_gstrings.parser({ abi: machineAbi }),
    ethtool_gstring: ethtool_gstring.parser({ abi: machineAbi }),
    ethtool_gfeatures: ethtool_gfeatures.parser({ abi: machineAbi }),
    ethtool_get_features_block: ethtool_get_features_block.parser({ abi: machineAbi }),
    ethtool_sfeatures: ethtool_sfeatures.parser({ abi: machineAbi }),
    ethtool_set_features_block: ethtool_set_features_block.parser({ abi: machineAbi }),
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
  sockopt_int,
  packet_mreq,
  tpacket_auxdata,
  cmsghdr,
  vlan_tag,
  ifmap,
  ifru_ifindex,
  ifru_data,
  ethtool_value,
  ethtool_sset_info,
  ethtool_sset_length,
  ethtool_gstrings,
  ethtool_gstring,
  ethtool_gfeatures,
  ethtool_get_features_block,
  ethtool_sfeatures,
  ethtool_set_features_block,
};
