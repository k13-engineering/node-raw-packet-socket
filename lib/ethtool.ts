import type { TMemoryInterface, TPo6Api } from "po6";
import { formatIfreq } from "./control-socket.ts";
import type { TRawPacketKernelAbi } from "./kernel-abi.ts";

type TOffloadName =
  "tx-checksumming" |
  "tcp-segmentation-offload" |
  "tx-udp-segmentation" |
  "generic-segmentation-offload" |
  "generic-receive-offload" |
  "rx-gro-hw" |
  "large-receive-offload" |
  "rx-vlan-filter";

type TLegacyFlag = {
  command: "ETHTOOL_GTXCSUM" | "ETHTOOL_GTSO" | "ETHTOOL_GGSO" | "ETHTOOL_GGRO" | "ETHTOOL_GFLAGS";
  // the bit of the offload, for commands that answer a bitmap instead of 0 or 1
  bit: "ETH_FLAG_LRO" | undefined;
};

type TOffloadDefinition = {
  featurePattern: string;
  legacyFlag: TLegacyFlag | undefined;
};

// bit i stands for feature i of the string set ETH_SS_FEATURES
type TFeatureState = {
  // dev->hw_features, the features that may be changed
  available: bigint;
  // dev->features
  active: bigint;
  // NETIF_F_NEVER_CHANGE
  neverChanged: bigint;
  // the legacy flag of the offload, e.g. from ETHTOOL_GTSO, if it has one
  offloadFlag: boolean | undefined;
};

type TReadFeatureNamesResult = {
  error: Error;
  featureNames: undefined;
} | {
  error: undefined;
  featureNames: string[];
};

type TReadFeatureStateResult = {
  error: Error;
  state: undefined;
} | {
  error: undefined;
  state: TFeatureState;
};

type TInspectResult = {
  error: Error;
  featureNames: undefined;
  state: undefined;
} | {
  error: undefined;
  featureNames: string[];
  state: TFeatureState;
};

// the offloads of `ethtool -K` with the pattern of the kernel feature names
// they stand for and their legacy flag, from off_flag_def in ethtool's
// common.c; ethtool reads the flag of LRO from the bitmap of ETHTOOL_GFLAGS.
// rx-gro-hw, tx-udp-segmentation and rx-vlan-filter are kernel feature
// names without a legacy flag, which ethtool -K takes as they are.
const offloadDefinitions: { [offload in TOffloadName]: TOffloadDefinition } = {
  "tx-checksumming": { featurePattern: "tx-checksum-*", legacyFlag: { command: "ETHTOOL_GTXCSUM", bit: undefined } },
  "tcp-segmentation-offload": { featurePattern: "tx-tcp*-segmentation", legacyFlag: { command: "ETHTOOL_GTSO", bit: undefined } },
  "tx-udp-segmentation": { featurePattern: "tx-udp-segmentation", legacyFlag: undefined },
  "generic-segmentation-offload": { featurePattern: "tx-generic-segmentation", legacyFlag: { command: "ETHTOOL_GGSO", bit: undefined } },
  "generic-receive-offload": { featurePattern: "rx-gro", legacyFlag: { command: "ETHTOOL_GGRO", bit: undefined } },
  "rx-gro-hw": { featurePattern: "rx-gro-hw", legacyFlag: undefined },
  "large-receive-offload": { featurePattern: "rx-lro", legacyFlag: { command: "ETHTOOL_GFLAGS", bit: "ETH_FLAG_LRO" } },
  "rx-vlan-filter": { featurePattern: "rx-vlan-filter", legacyFlag: undefined },
};

const bitsPerBlock = 32;

// the first of the offloads that is not known, e.g. from JavaScript
const unknownOffloadIn = ({ offloads }: { offloads: string[] }) => {
  return offloads.find((offload) => {
    return !Object.hasOwn(offloadDefinitions, offload);
  });
};

// like in ethtool, a "*" matches any part of the name, also an empty one
const featureNameMatches = ({ name, pattern }: { name: string, pattern: string }) => {
  const [prefix, suffix] = pattern.split("*");

  if (suffix === undefined) {
    return name === pattern;
  }

  return name.startsWith(prefix) && name.slice(prefix.length).endsWith(suffix);
};

const featureBitsMatching = ({ featureNames, pattern }: { featureNames: string[], pattern: string }) => {
  return featureNames.reduce((bits, name, index) => {
    return featureNameMatches({ name, pattern }) ? bits | (1n << BigInt(index)) : bits;
  }, 0n);
};

const blockCountFor = ({ featureNames }: { featureNames: string[] }) => {
  return Math.ceil(featureNames.length / bitsPerBlock);
};

const bitsFromBlocks = ({ blocks }: { blocks: bigint[] }) => {
  return blocks.reduce((bits, block, index) => {
    return bits | (block << BigInt(index * bitsPerBlock));
  }, 0n);
};

const blocksFromBits = ({ bits, blockCount }: { bits: bigint, blockCount: number }) => {
  return Array.from({ length: blockCount }).map((_, index) => {
    return BigInt.asUintN(bitsPerBlock, bits >> BigInt(index * bitsPerBlock));
  });
};

const concatBytes = ({ arrays }: { arrays: Uint8Array[] }) => {
  const result = new Uint8Array(arrays.reduce((length, array) => {
    return length + array.length;
  }, 0));

  arrays.reduce((offset, array) => {
    result.set(array, offset);
    return offset + array.length;
  }, 0);

  return result;
};

const splitIntoEntries = ({ data, entrySize, count }: { data: Uint8Array, entrySize: number, count: number }) => {
  return Array.from({ length: count }).map((_, index) => {
    return data.subarray(index * entrySize, (index + 1) * entrySize);
  });
};

const changedBetween = ({ oldState, newState }: { oldState: TFeatureState, newState: TFeatureState }) => {
  return newState.offloadFlag !== oldState.offloadFlag || newState.active !== oldState.active;
};

// an offload without a legacy flag is on as long as one of its features is
const offloadOn = ({ state, matching }: { state: TFeatureState, matching: bigint }) => {
  return state.offloadFlag ?? (state.active & matching) !== 0n;
};

const turnedOff = ({
  oldState,
  newState,
  matching,
  valid
}: {
  oldState: TFeatureState,
  newState: TFeatureState,
  matching: bigint,
  valid: bigint
}) => {
  return !offloadOn({ state: newState, matching }) && newState.active === (oldState.active & ~valid);
};

// like ethtool, only fail if the features are not as requested and nothing changed at all
const checkOutcome = ({
  interfaceName,
  offload,
  oldState,
  newState,
  matching,
  valid
}: {
  interfaceName: string,
  offload: TOffloadName,
  oldState: TFeatureState,
  newState: TFeatureState,
  matching: bigint,
  valid: bigint
}) => {
  if (turnedOff({ oldState, newState, matching, valid }) || changedBetween({ oldState, newState })) {
    return { error: undefined };
  }

  return { error: Error(`could not disable ${offload} of interface "${interfaceName}"`) };
};

// Replicates `ethtool -K <interface> <offload> off` with SIOCETHTOOL ioctls,
// as do_sfeatures() in ethtool.c does without netlink:
//
// - read the names of the kernel features (ETHTOOL_GSSET_INFO, ETHTOOL_GSTRINGS)
// - read the state of the features (ETHTOOL_GFEATURES) and the legacy flag
//   of the offload, if it has one (e.g. ETHTOOL_GTSO)
// - turn off the features that match the name pattern of the offload and that
//   the device allows changing (ETHTOOL_SFEATURES)
// - read the state again; only fail if it is not as requested and nothing
//   changed at all, e.g. because the device does not allow changing the offload
//
// The legacy commands like ETHTOOL_STSO do not suffice: they miss features
// the name pattern matches, e.g. tx-tcp-accecn-segmentation.
//
// The changes last until the interface goes away, e.g. on reboot.
const createEthtool = ({
  po6,
  kernelAbi,
  memory
}: {
  po6: TPo6Api,
  kernelAbi: TRawPacketKernelAbi,
  memory: TMemoryInterface
}) => {

  const { constants } = kernelAbi;

  // ioctl(fd, SIOCETHTOOL, &ifr) with ifr.ifr_data pointing to request, which
  // the kernel reads and overwrites with its answer
  const ethtoolIoctl = ({
    fd,
    interfaceName,
    commandName,
    request
  }: {
    fd: number,
    interfaceName: string,
    commandName: string,
    request: Uint8Array
  }): { error: Error | undefined } => {
    // the kernel gets the address of request inside of ifr, so it must not move
    const pinnedRequest = memory.pinBuffer({ buffer: request });

    try {
      const ifr = formatIfreq({
        kernelAbi,
        interfaceName,
        ifru: kernelAbi.ifru_data.format({ value: { ifr_data: pinnedRequest.address } })
      });

      const { errno } = po6.ioctl({ fd, request: constants.SIOCETHTOOL, args: [ifr] });
      if (errno !== undefined) {
        return { error: po6.createErrorFromErrno({ operation: `ioctl(SIOCETHTOOL, ${commandName})`, errno }) };
      }

      return { error: undefined };
    } finally {
      pinnedRequest.unpin();
    }
  };

  const readFeatureCount = ({ fd, interfaceName }: { fd: number, interfaceName: string }) => {
    const request = concatBytes({
      arrays: [
        kernelAbi.ethtool_sset_info.format({
          value: { cmd: constants.ETHTOOL_GSSET_INFO, reserved: 0n, sset_mask: 1n << constants.ETH_SS_FEATURES }
        }),
        new Uint8Array(kernelAbi.ethtool_sset_length.size),
      ]
    });

    const { error } = ethtoolIoctl({ fd, interfaceName, commandName: "ETHTOOL_GSSET_INFO", request });
    if (error !== undefined) {
      return { error, featureCount: undefined };
    }

    // the kernel clears the bits of the string sets it does not know
    if (kernelAbi.ethtool_sset_info.parse({ data: request }).sset_mask === 0n) {
      return { error: Error(`interface "${interfaceName}" has no feature names`), featureCount: undefined };
    }

    const { length } = kernelAbi.ethtool_sset_length.parse({ data: request.subarray(kernelAbi.ethtool_sset_info.size) });

    return { error: undefined, featureCount: Number(length) };
  };

  const readFeatureNames = ({ fd, interfaceName }: { fd: number, interfaceName: string }): TReadFeatureNamesResult => {
    const { error: countError, featureCount } = readFeatureCount({ fd, interfaceName });
    if (countError !== undefined) {
      return { error: countError, featureNames: undefined };
    }

    const request = concatBytes({
      arrays: [
        kernelAbi.ethtool_gstrings.format({
          value: { cmd: constants.ETHTOOL_GSTRINGS, string_set: constants.ETH_SS_FEATURES, len: BigInt(featureCount) }
        }),
        new Uint8Array(featureCount * kernelAbi.ethtool_gstring.size),
      ]
    });

    const { error } = ethtoolIoctl({ fd, interfaceName, commandName: "ETHTOOL_GSTRINGS", request });
    if (error !== undefined) {
      return { error, featureNames: undefined };
    }

    const entries = splitIntoEntries({
      data: request.subarray(kernelAbi.ethtool_gstrings.size),
      entrySize: kernelAbi.ethtool_gstring.size,
      count: featureCount
    });

    return {
      error: undefined,
      featureNames: entries.map((data) => {
        return kernelAbi.ethtool_gstring.parse({ data }).string;
      })
    };
  };

  const readOffloadFlag = ({ fd, interfaceName, offload }: { fd: number, interfaceName: string, offload: TOffloadName }) => {
    const { legacyFlag } = offloadDefinitions[offload];
    if (legacyFlag === undefined) {
      return { error: undefined, offloadFlag: undefined };
    }

    const { command, bit } = legacyFlag;
    const request = kernelAbi.ethtool_value.format({ value: { cmd: constants[command], data: 0n } });

    const { error } = ethtoolIoctl({ fd, interfaceName, commandName: command, request });
    if (error !== undefined) {
      return { error, offloadFlag: undefined };
    }

    const { data } = kernelAbi.ethtool_value.parse({ data: request });
    const flag = bit === undefined ? data : data & constants[bit];

    return { error: undefined, offloadFlag: flag !== 0n };
  };

  const readFeatureState = ({
    fd,
    interfaceName,
    offload,
    blockCount
  }: {
    fd: number,
    interfaceName: string,
    offload: TOffloadName,
    blockCount: number
  }): TReadFeatureStateResult => {
    const { error: flagError, offloadFlag } = readOffloadFlag({ fd, interfaceName, offload });
    if (flagError !== undefined) {
      return { error: flagError, state: undefined };
    }

    const request = concatBytes({
      arrays: [
        kernelAbi.ethtool_gfeatures.format({ value: { cmd: constants.ETHTOOL_GFEATURES, size: BigInt(blockCount) } }),
        new Uint8Array(blockCount * kernelAbi.ethtool_get_features_block.size),
      ]
    });

    const { error } = ethtoolIoctl({ fd, interfaceName, commandName: "ETHTOOL_GFEATURES", request });
    if (error !== undefined) {
      return { error, state: undefined };
    }

    const blocks = splitIntoEntries({
      data: request.subarray(kernelAbi.ethtool_gfeatures.size),
      entrySize: kernelAbi.ethtool_get_features_block.size,
      count: blockCount
    }).map((data) => {
      return kernelAbi.ethtool_get_features_block.parse({ data });
    });

    const bitsOf = ({ field }: { field: "available" | "active" | "never_changed" }) => {
      return bitsFromBlocks({
        blocks: blocks.map((block) => {
          return block[field];
        })
      });
    };

    return {
      error: undefined,
      state: {
        available: bitsOf({ field: "available" }),
        active: bitsOf({ field: "active" }),
        neverChanged: bitsOf({ field: "never_changed" }),
        offloadFlag
      }
    };
  };

  // turns off the valid features
  const writeFeatures = ({
    fd,
    interfaceName,
    valid,
    blockCount
  }: {
    fd: number,
    interfaceName: string,
    valid: bigint,
    blockCount: number
  }) => {
    const blocks = blocksFromBits({ bits: valid, blockCount }).map((validBlock) => {
      return kernelAbi.ethtool_set_features_block.format({ value: { valid: validBlock, requested: 0n } });
    });

    const request = concatBytes({
      arrays: [
        kernelAbi.ethtool_sfeatures.format({ value: { cmd: constants.ETHTOOL_SFEATURES, size: BigInt(blockCount) } }),
        ...blocks,
      ]
    });

    // a positive result like ETHTOOL_F_WISH is no error, the comparison below tells what happened
    return ethtoolIoctl({ fd, interfaceName, commandName: "ETHTOOL_SFEATURES", request });
  };

  const inspect = ({ fd, interfaceName, offload }: { fd: number, interfaceName: string, offload: TOffloadName }): TInspectResult => {
    const { error: namesError, featureNames } = readFeatureNames({ fd, interfaceName });
    if (namesError !== undefined) {
      return { error: namesError, featureNames: undefined, state: undefined };
    }

    const { error: stateError, state } = readFeatureState({ fd, interfaceName, offload, blockCount: blockCountFor({ featureNames }) });
    if (stateError !== undefined) {
      return { error: stateError, featureNames: undefined, state: undefined };
    }

    return { error: undefined, featureNames, state };
  };

  const changeAndCompare = ({
    fd,
    interfaceName,
    offload,
    blockCount,
    oldState,
    matching,
    valid
  }: {
    fd: number,
    interfaceName: string,
    offload: TOffloadName,
    blockCount: number,
    oldState: TFeatureState,
    matching: bigint,
    valid: bigint
  }) => {
    const { error: writeError } = writeFeatures({ fd, interfaceName, valid, blockCount });
    if (writeError !== undefined) {
      return { error: writeError };
    }

    const { error: stateError, state: newState } = readFeatureState({ fd, interfaceName, offload, blockCount });
    if (stateError !== undefined) {
      return { error: stateError };
    }

    return checkOutcome({ interfaceName, offload, oldState, newState, matching, valid });
  };

  const disableOffload = ({ fd, interfaceName, offload }: { fd: number, interfaceName: string, offload: TOffloadName }) => {
    const { error, featureNames, state } = inspect({ fd, interfaceName, offload });
    if (error !== undefined) {
      return { error };
    }

    const matching = featureBitsMatching({ featureNames, pattern: offloadDefinitions[offload].featurePattern });
    const valid = matching & state.available & ~state.neverChanged;

    return changeAndCompare({
      fd,
      interfaceName,
      offload,
      blockCount: blockCountFor({ featureNames }),
      oldState: state,
      matching,
      valid
    });
  };

  const disableOffloads = ({
    fd,
    interfaceName,
    offloads
  }: {
    fd: number,
    interfaceName: string,
    offloads: TOffloadName[]
  }): { error: Error | undefined } => {
    for (const offload of offloads) {
      const { error } = disableOffload({ fd, interfaceName, offload });
      if (error !== undefined) {
        return { error };
      }
    }

    return { error: undefined };
  };

  return {
    disableOffloads
  };
};

export type {
  TOffloadName
};

export {
  createEthtool,
  unknownOffloadIn
};
