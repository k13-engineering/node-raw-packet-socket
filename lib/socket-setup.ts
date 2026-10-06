import type { TPo6Api } from "po6";
import type { TOffloadName } from "./ethtool.ts";
import type { TRawPacketKernelAbi } from "./kernel-abi.ts";
import type { TSocket } from "./socket.ts";

// what to set up, from the options of createNodeDuplexByInterfaceIndex()
type TSocketSetupOptions = {
  ifindex: number;
  offloads: TOffloadName[];
  enablePromiscuousMode: boolean;
  ignoreOutgoingFrames: boolean;
  restoreVlanTags: boolean;
};

type TSetupResult = {
  error: Error | undefined;
};

type TDisableOffloads = (args: { ifindex: number, offloads: TOffloadName[] }) => TSetupResult;

type TSetupStep = (args: { socket: TSocket, options: TSocketSetupOptions }) => TSetupResult;

const createSocketSetup = ({
  po6,
  kernelAbi,
  disableOffloads
}: {
  po6: TPo6Api,
  kernelAbi: TRawPacketKernelAbi,
  disableOffloads: TDisableOffloads
}) => {

  const { constants } = kernelAbi;

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

  const enableOption = ({ socket, optname, name }: { socket: TSocket, optname: bigint, name: string }) => {
    const { errno } = socket.sockopt.packet.setInt({ optname, value: 1 });

    if (errno !== undefined) {
      return { error: po6.createErrorFromErrno({ operation: `setsockopt(${name})`, errno }) };
    }

    return { error: undefined };
  };

  // the socket receives frames from bind() on, so its options come first
  const setupSteps: TSetupStep[] = [
    ({ socket, options }) => {
      if (!options.ignoreOutgoingFrames) {
        return { error: undefined };
      }

      return enableOption({ socket, optname: constants.PACKET_IGNORE_OUTGOING, name: "PACKET_IGNORE_OUTGOING" });
    },
    ({ socket, options }) => {
      if (!options.restoreVlanTags) {
        return { error: undefined };
      }

      return enableOption({ socket, optname: constants.PACKET_AUXDATA, name: "PACKET_AUXDATA" });
    },
    ({ socket, options }) => {
      return bindToInterface({ socket, ifindex: options.ifindex });
    },
    ({ options }) => {
      return disableOffloads({ ifindex: options.ifindex, offloads: options.offloads });
    },
    ({ socket, options }) => {
      return options.enablePromiscuousMode ? enablePromiscuousMode({ socket, ifindex: options.ifindex }) : { error: undefined };
    },
  ];

  // stops at the first step that fails
  const setup = ({ socket, options }: { socket: TSocket, options: TSocketSetupOptions }): TSetupResult => {
    for (const step of setupSteps) {
      const { error } = step({ socket, options });
      if (error !== undefined) {
        return { error };
      }
    }

    return { error: undefined };
  };

  return {
    setup
  };
};

export type {
  TSocketSetupOptions
};

export {
  createSocketSetup
};
