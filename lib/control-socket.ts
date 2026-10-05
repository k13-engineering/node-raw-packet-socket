import type { TErrorWithErrno, TPo6Api } from "po6";
import type { TRawPacketKernelAbi } from "./kernel-abi.ts";

type TWithControlSocketResult<T> = {
  error: TErrorWithErrno;
  result: undefined;
} | {
  error: undefined;
  result: T;
};

// struct ifreq with ifru as the member of its union ifr_ifru
const formatIfreq = ({
  kernelAbi,
  interfaceName,
  ifru
}: {
  kernelAbi: TRawPacketKernelAbi,
  interfaceName: string,
  ifru: Uint8Array
}): Uint8Array => {
  const ifr_ifru = new Uint8Array(kernelAbi.ifmap.size);
  ifr_ifru.set(ifru);

  return kernelAbi.ifreq.format({
    value: {
      ifr_name: interfaceName,
      ifr_ifru
    }
  });
};

const createControlSocketRunner = ({ po6, kernelAbi }: { po6: TPo6Api, kernelAbi: TRawPacketKernelAbi }) => {

  const { constants } = kernelAbi;

  // interface ioctls go through a socket of any family, ethtool uses an
  // AF_INET datagram socket as well; it is closed again after the callback
  const withControlSocket = <T>({ callback }: { callback: (args: { fd: number }) => T }): TWithControlSocketResult<T> => {
    const { errno, fd } = po6.socket({
      domain: constants.AF_INET,
      type: constants.SOCK_DGRAM | constants.SOCK_CLOEXEC,
      protocol: 0
    });

    if (errno !== undefined) {
      return {
        error: po6.createErrorFromErrno({ operation: "socket()", errno }),
        result: undefined
      };
    }

    try {
      return {
        error: undefined,
        result: callback({ fd })
      };
    } finally {
      po6.close({ fd });
    }
  };

  return {
    withControlSocket
  };
};

type TControlSocketRunner = ReturnType<typeof createControlSocketRunner>;

export type {
  TControlSocketRunner
};

export {
  createControlSocketRunner,
  formatIfreq
};
