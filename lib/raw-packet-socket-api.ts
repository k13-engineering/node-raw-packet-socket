import nodeChildProcess from "node:child_process";
import type nodeStream from "node:stream";
import duplexify from "duplexify";
import { createPo6Api } from "po6";
import { createControlSocketRunner } from "./control-socket.ts";
import { createInterfaceNames } from "./interface-names.ts";
import type { TRawPacketKernelAbi } from "./kernel-abi.ts";
import type { TKernel } from "./kernel.ts";
import { createAndSteal } from "./socket-duplex.ts";
import { createSocketFactory, type TSocket } from "./socket.ts";

type TOffloadName = "tcp-segmentation-offload" | "generic-segmentation-offload" | "generic-receive-offload";

type TCreateNodeDuplexByInterfaceIndexArgs = {
  ifindex: number;
  disableTcpSegmentationOffloadUntilReboot?: boolean;
  disableGenericSegmentationOffloadUntilReboot?: boolean;
  disableGenericReceiveOffloadUntilReboot?: boolean;
  enablePromiscuousMode?: boolean;
};

type TOpenSocketResult = {
  error: Error;
  socket: undefined;
} | {
  error: undefined;
  socket: TSocket;
};

const offloadsToDisableFor = ({
  disableTcpSegmentationOffloadUntilReboot = false,
  disableGenericSegmentationOffloadUntilReboot = false,
  disableGenericReceiveOffloadUntilReboot = false,
}: TCreateNodeDuplexByInterfaceIndexArgs): TOffloadName[] => {
  const offloads: [TOffloadName, boolean][] = [
    ["tcp-segmentation-offload", disableTcpSegmentationOffloadUntilReboot],
    ["generic-segmentation-offload", disableGenericSegmentationOffloadUntilReboot],
    ["generic-receive-offload", disableGenericReceiveOffloadUntilReboot],
  ];

  return offloads.filter(([, disable]) => {
    return disable;
  }).map(([offloadName]) => {
    return offloadName;
  });
};

const disableOffloadViaEthtool = async ({
  interfaceName,
  offloadName
}: {
  interfaceName: string,
  offloadName: TOffloadName
}): Promise<{ error: Error | undefined }> => {
  return await new Promise((resolve) => {
    nodeChildProcess.execFile("ethtool", ["-K", interfaceName, offloadName, "off"], (error) => {
      resolve({ error: error ?? undefined });
    });
  });
};

const disableOffloadsViaEthtool = async ({
  interfaceName,
  offloads
}: {
  interfaceName: string,
  offloads: TOffloadName[]
}): Promise<{ error: Error | undefined }> => {
  for (const offloadName of offloads) {
    const { error } = await disableOffloadViaEthtool({ interfaceName, offloadName });
    if (error !== undefined) {
      return { error };
    }
  }

  return { error: undefined };
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
}) => {

  const { constants } = kernelAbi;

  const po6 = createPo6Api({
    kernelInterface: kernel.kernelInterface,
    kernelAbi: kernelAbi.po6,
    memory: kernel.memory
  });

  const socketFactory = createSocketFactory({ po6, kernelAbi, createPoller: kernel.createPoller });
  const controlSocketRunner = createControlSocketRunner({ po6, kernelAbi });
  const { findInterfaceIndexByName, findInterfaceNameByIndex } = createInterfaceNames({ po6, kernelAbi, controlSocketRunner });

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

  const disableOffloads = async ({ ifindex, offloads }: { ifindex: number, offloads: TOffloadName[] }) => {
    if (offloads.length === 0) {
      return { error: undefined };
    }

    const { error: findNameError, interfaceName } = findInterfaceNameByIndex({ ifindex });
    if (findNameError !== undefined) {
      return { error: findNameError };
    }

    // RACE! interface name might change between we find it and call ethtool
    // TODO: use netlink

    return await disableOffloadsViaEthtool({ interfaceName, offloads });
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

  const setup = async ({ socket, args }: { socket: TSocket, args: TCreateNodeDuplexByInterfaceIndexArgs }) => {
    const { ifindex } = args;

    const { error: bindError } = bindToInterface({ socket, ifindex });
    if (bindError !== undefined) {
      return { error: bindError };
    }

    const { error: offloadsError } = await disableOffloads({ ifindex, offloads: offloadsToDisableFor(args) });
    if (offloadsError !== undefined) {
      return { error: offloadsError };
    }

    if (args.enablePromiscuousMode !== true) {
      return { error: undefined };
    }

    return enablePromiscuousMode({ socket, ifindex });
  };

  const openSocket = async ({ args }: { args: TCreateNodeDuplexByInterfaceIndexArgs }): Promise<TOpenSocketResult> => {
    // protocol 0 receives nothing until bind() selects the interface and ETH_P_ALL
    const { error: socketError, socket } = socketFactory.create({
      domain: constants.AF_PACKET,
      type: constants.SOCK_RAW | constants.SOCK_NONBLOCK | constants.SOCK_CLOEXEC,
      protocol: 0n,
    });

    if (socketError !== undefined) {
      return { error: socketError, socket: undefined };
    }

    const { error: setupError } = await setup({ socket, args });
    if (setupError !== undefined) {
      socket.close();
      return { error: setupError, socket: undefined };
    }

    return { error: undefined, socket };
  };

  const createNodeDuplexByInterfaceIndex = (args: TCreateNodeDuplexByInterfaceIndexArgs): nodeStream.Duplex => {

    const duplex = duplexify();

    // all errors should raise "error" events, therefore we do our work in another task
    setTimeout(async () => {

      if (duplex.destroyed) {
        return;
      }

      const { error, socket } = await openSocket({ args });
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

  return {
    createNodeDuplexByInterfaceIndex,
    findInterfaceIndexByName,
    findInterfaceNameByIndex
  };
};

type TRawPacketSocketApi = ReturnType<typeof createRawPacketSocketApi>;

export type {
  TCreateNodeDuplexByInterfaceIndexArgs,
  TRawPacketSocketApi
};

export {
  createRawPacketSocketApi
};
