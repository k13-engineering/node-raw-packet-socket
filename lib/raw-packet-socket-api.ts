import type nodeStream from "node:stream";
import duplexify from "duplexify";
import { createPo6Api } from "po6";
import { createControlSocketRunner } from "./control-socket.ts";
import { createEthtool, unknownOffloadIn, type TOffloadName } from "./ethtool.ts";
import { createInterfaceNames, type TFindInterfaceIndexResult } from "./interface-names.ts";
import type { TRawPacketKernelAbi } from "./kernel-abi.ts";
import type { TKernel } from "./kernel.ts";
import { createAndSteal, keepFrames } from "./socket-duplex.ts";
import { createSocketSetup, type TSocketSetupOptions } from "./socket-setup.ts";
import { createSocketFactory, type TSocket } from "./socket.ts";
import { createVlanTagRestorer } from "./vlan-tags.ts";

type TCreateNodeDuplexByInterfaceIndexArgs = {
  ifindex: number;
  disableTcpSegmentationOffloadUntilReboot?: boolean;
  disableGenericSegmentationOffloadUntilReboot?: boolean;
  disableGenericReceiveOffloadUntilReboot?: boolean;
  disableHardwareGenericReceiveOffloadUntilReboot?: boolean;
  disableLargeReceiveOffloadUntilReboot?: boolean;
  disableUdpSegmentationOffloadUntilReboot?: boolean;
  disableTransmitChecksumOffloadUntilReboot?: boolean;
  disableVlanFilterUntilReboot?: boolean;
  enablePromiscuousMode?: boolean;
  ignoreOutgoingFrames?: boolean;
  restoreVlanTags?: boolean;
};

type TDisableOffloadsUntilRebootArgs = {
  ifindex: number;
  offloads: TOffloadName[];
};

// spelled out, as the declaration files are generated per file and could
// not resolve the types of the imported factories otherwise
type TRawPacketSocketApi = {
  createNodeDuplexByInterfaceIndex: (args: TCreateNodeDuplexByInterfaceIndexArgs) => nodeStream.Duplex;
  disableOffloadsUntilReboot: (args: TDisableOffloadsUntilRebootArgs) => { error: Error | undefined };
  findInterfaceIndexByName: (args: { interfaceName: string }) => TFindInterfaceIndexResult;
};

type TOpenSocketResult = {
  error: Error;
  socket: undefined;
} | {
  error: undefined;
  socket: TSocket;
};

// the option that asks to disable each offload
const offloadOptions: [TOffloadName, keyof TCreateNodeDuplexByInterfaceIndexArgs][] = [
  ["tcp-segmentation-offload", "disableTcpSegmentationOffloadUntilReboot"],
  ["generic-segmentation-offload", "disableGenericSegmentationOffloadUntilReboot"],
  ["generic-receive-offload", "disableGenericReceiveOffloadUntilReboot"],
  ["rx-gro-hw", "disableHardwareGenericReceiveOffloadUntilReboot"],
  ["large-receive-offload", "disableLargeReceiveOffloadUntilReboot"],
  ["tx-udp-segmentation", "disableUdpSegmentationOffloadUntilReboot"],
  ["tx-checksumming", "disableTransmitChecksumOffloadUntilReboot"],
  ["rx-vlan-filter", "disableVlanFilterUntilReboot"],
];

const offloadsToDisableFor = (args: TCreateNodeDuplexByInterfaceIndexArgs): TOffloadName[] => {
  return offloadOptions.filter(([, option]) => {
    return args[option] === true;
  }).map(([offload]) => {
    return offload;
  });
};

const socketSetupOptionsFor = (args: TCreateNodeDuplexByInterfaceIndexArgs): TSocketSetupOptions => {
  return {
    ifindex: args.ifindex,
    offloads: offloadsToDisableFor(args),
    enablePromiscuousMode: args.enablePromiscuousMode === true,
    ignoreOutgoingFrames: args.ignoreOutgoingFrames === true,
    restoreVlanTags: args.restoreVlanTags === true,
  };
};

// "open" and "ready" for compatibility with net.Socket
const emitOpenAndReady = ({ duplex }: { duplex: nodeStream.Duplex }) => {
  for (const event of ["open", "ready"]) {
    if (duplex.destroyed) {
      return;
    }
    duplex.emit(event);
  }
};

const createRawPacketSocketApi = ({
  kernel,
  kernelAbi
}: {
  kernel: TKernel,
  kernelAbi: TRawPacketKernelAbi
}): TRawPacketSocketApi => {

  const { constants } = kernelAbi;

  const po6 = createPo6Api({
    kernelInterface: kernel.kernelInterface,
    kernelAbi: kernelAbi.po6,
    memory: kernel.memory
  });

  const socketFactory = createSocketFactory({ po6, kernelAbi, createPoller: kernel.createPoller });
  const controlSocketRunner = createControlSocketRunner({ po6, kernelAbi });
  const interfaceNames = createInterfaceNames({ po6, kernelAbi, controlSocketRunner });
  const ethtool = createEthtool({ po6, kernelAbi, memory: kernel.memory });
  const vlanTagRestorer = createVlanTagRestorer({ kernelAbi });

  const disableOffloadsUsing = ({ fd, ifindex, offloads }: { fd: number, ifindex: number, offloads: TOffloadName[] }) => {
    const { error, interfaceName } = interfaceNames.findInterfaceNameByIndexUsing({ fd, ifindex });
    if (error !== undefined) {
      return { error };
    }

    // RACE! the interface might be renamed before the ioctls address it by
    // name, as ethtool does as well
    // TODO: use ethtool netlink, which addresses interfaces by index

    return ethtool.disableOffloads({ fd, interfaceName, offloads });
  };

  const disableOffloads = ({ ifindex, offloads }: { ifindex: number, offloads: TOffloadName[] }) => {
    if (offloads.length === 0) {
      return { error: undefined };
    }

    const { error, result } = controlSocketRunner.withControlSocket({
      callback: ({ fd }) => {
        return disableOffloadsUsing({ fd, ifindex, offloads });
      }
    });

    return error === undefined ? result : { error };
  };

  const socketSetup = createSocketSetup({ po6, kernelAbi, disableOffloads });

  const openSocket = ({ args }: { args: TCreateNodeDuplexByInterfaceIndexArgs }): TOpenSocketResult => {
    // protocol 0 receives nothing until bind() selects the interface and ETH_P_ALL
    const { error: socketError, socket } = socketFactory.create({
      domain: constants.AF_PACKET,
      type: constants.SOCK_RAW | constants.SOCK_NONBLOCK | constants.SOCK_CLOEXEC,
      protocol: 0n,
    });

    if (socketError !== undefined) {
      return { error: socketError, socket: undefined };
    }

    const { error: setupError } = socketSetup.setup({ socket, options: socketSetupOptionsFor(args) });
    if (setupError !== undefined) {
      socket.close();
      return { error: setupError, socket: undefined };
    }

    return { error: undefined, socket };
  };

  const createNodeDuplexByInterfaceIndex = (args: TCreateNodeDuplexByInterfaceIndexArgs): nodeStream.Duplex => {

    const duplex = duplexify();

    // the socket is set up right away, as the interface index only means
    // something in the network namespace of the caller, which might switch
    // namespaces again before the next task
    const { error, socket } = openSocket({ args });

    // all errors should raise "error" events, therefore we report them in another task
    if (error !== undefined) {
      setTimeout(() => {
        duplex.destroy(error);
      }, 0);
      return duplex;
    }

    const socketDuplex = createAndSteal({
      socket,
      errnoCodes: kernelAbi.po6.errnoCodes,
      createErrorFromErrno: po6.createErrorFromErrno,
      frameRestorer: args.restoreVlanTags === true ? vlanTagRestorer : keepFrames
    });
    duplex.setReadable(socketDuplex);
    duplex.setWritable(socketDuplex);

    setTimeout(() => {
      emitOpenAndReady({ duplex });
    }, 0);

    return duplex;
  };

  // without a packet socket, e.g. for the parent of a macvlan interface
  const disableOffloadsUntilReboot: TRawPacketSocketApi["disableOffloadsUntilReboot"] = ({ ifindex, offloads }) => {
    const unknownOffload = unknownOffloadIn({ offloads });
    if (unknownOffload !== undefined) {
      return { error: Error(`unknown offload "${unknownOffload}"`) };
    }

    return disableOffloads({ ifindex, offloads });
  };

  return {
    createNodeDuplexByInterfaceIndex,
    disableOffloadsUntilReboot,
    findInterfaceIndexByName: interfaceNames.findInterfaceIndexByName
  };
};

export type {
  TCreateNodeDuplexByInterfaceIndexArgs,
  TDisableOffloadsUntilRebootArgs,
  TRawPacketSocketApi
};

export {
  createRawPacketSocketApi
};
