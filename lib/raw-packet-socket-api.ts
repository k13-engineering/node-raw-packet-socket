import type nodeStream from "node:stream";
import duplexify from "duplexify";
import { createPo6Api } from "po6";
import { createControlSocketRunner } from "./control-socket.ts";
import { createEthtool, unknownOffloadIn, type TOffloadName } from "./ethtool.ts";
import { createInterfaceNames, type TFindInterfaceIndexResult } from "./interface-names.ts";
import type { TRawPacketKernelAbi } from "./kernel-abi.ts";
import type { TKernel } from "./kernel.ts";
import { createAndSteal } from "./socket-duplex.ts";
import { createSocketFactory, type TSocket } from "./socket.ts";

type TCreateNodeDuplexByInterfaceIndexArgs = {
  ifindex: number;
  disableTcpSegmentationOffloadUntilReboot?: boolean;
  disableGenericSegmentationOffloadUntilReboot?: boolean;
  disableGenericReceiveOffloadUntilReboot?: boolean;
  disableHardwareGenericReceiveOffloadUntilReboot?: boolean;
  disableLargeReceiveOffloadUntilReboot?: boolean;
  disableUdpSegmentationOffloadUntilReboot?: boolean;
  disableTransmitChecksumOffloadUntilReboot?: boolean;
  enablePromiscuousMode?: boolean;
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
];

const offloadsToDisableFor = (args: TCreateNodeDuplexByInterfaceIndexArgs): TOffloadName[] => {
  return offloadOptions.filter(([, option]) => {
    return args[option] === true;
  }).map(([offload]) => {
    return offload;
  });
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

  const bindToInterface = ({ socket, ifindex }: { socket: TSocket, ifindex: number }) => {
    const sockaddr = kernelAbi.sockaddr_ll.format({
      value: {
        sll_family: constants.AF_PACKET,
        sll_protocol: constants.ETH_P_ALL,
        sll_ifindex: BigInt(ifindex),
        sll_hatype: 0n,
        sll_pkttype: 0n,
        sll_halen: 0n,
        sll_addr: new Uint8Array(8),
      }
    });

    const { errno } = socket.bind({ sockaddr });
    if (errno !== undefined) {
      return { error: po6.createErrorFromErrno({ operation: "bind()", errno }) };
    }

    return { error: undefined };
  };

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

  const enablePromiscuousMode = ({ socket, ifindex }: { socket: TSocket, ifindex: number }) => {
    const { errno } = socket.sockopt.packet.addMembership({
      ifindex,
      action: kernelAbi.po6.constants.PACKET_MR_PROMISC
    });

    if (errno !== undefined) {
      return { error: po6.createErrorFromErrno({ operation: "setsockopt(PACKET_ADD_MEMBERSHIP)", errno }) };
    }

    return { error: undefined };
  };

  const setup = ({ socket, args }: { socket: TSocket, args: TCreateNodeDuplexByInterfaceIndexArgs }) => {
    const { ifindex } = args;

    const { error: bindError } = bindToInterface({ socket, ifindex });
    if (bindError !== undefined) {
      return { error: bindError };
    }

    const { error: offloadsError } = disableOffloads({ ifindex, offloads: offloadsToDisableFor(args) });
    if (offloadsError !== undefined) {
      return { error: offloadsError };
    }

    if (args.enablePromiscuousMode !== true) {
      return { error: undefined };
    }

    return enablePromiscuousMode({ socket, ifindex });
  };

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

    const { error: setupError } = setup({ socket, args });
    if (setupError !== undefined) {
      socket.close();
      return { error: setupError, socket: undefined };
    }

    return { error: undefined, socket };
  };

  const createNodeDuplexByInterfaceIndex = (args: TCreateNodeDuplexByInterfaceIndexArgs): nodeStream.Duplex => {

    const duplex = duplexify();

    // all errors should raise "error" events, therefore we do our work in another task
    setTimeout(() => {

      if (duplex.destroyed) {
        return;
      }

      const { error, socket } = openSocket({ args });
      if (error !== undefined) {
        duplex.destroy(error);
        return;
      }

      const socketDuplex = createAndSteal({
        socket,
        errnoCodes: kernelAbi.po6.errnoCodes,
        createErrorFromErrno: po6.createErrorFromErrno
      });
      duplex.setReadable(socketDuplex);
      duplex.setWritable(socketDuplex);

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
