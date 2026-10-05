import type { TPo6Api } from "po6";
import { formatIfreq, type TControlSocketRunner } from "./control-socket.ts";
import type { TRawPacketKernelAbi } from "./kernel-abi.ts";

type TFindInterfaceIndexResult = {
  error: Error;
  ifindex: undefined;
} | {
  error: undefined;
  ifindex: number;
};

type TFindInterfaceNameResult = {
  error: Error;
  interfaceName: undefined;
} | {
  error: undefined;
  interfaceName: string;
};

// IFNAMSIZ includes the terminating null byte
const maxInterfaceNameLength = 15;

const createInterfaceNames = ({
  po6,
  kernelAbi,
  controlSocketRunner
}: {
  po6: TPo6Api,
  kernelAbi: TRawPacketKernelAbi,
  controlSocketRunner: TControlSocketRunner
}) => {

  const { constants } = kernelAbi;
  const { errnoCodes } = kernelAbi.po6;

  const findInterfaceIndexByNameUsing = ({ fd, interfaceName }: { fd: number, interfaceName: string }): TFindInterfaceIndexResult => {
    const ifr = formatIfreq({ kernelAbi, interfaceName, ifru: new Uint8Array(0) });

    const { errno } = po6.ioctl({ fd, request: constants.SIOCGIFINDEX, args: [ifr] });

    if (errno === errnoCodes.ENODEV) {
      return { error: Error(`interface "${interfaceName}" not found`), ifindex: undefined };
    }

    if (errno !== undefined) {
      return { error: po6.createErrorFromErrno({ operation: "ioctl(SIOCGIFINDEX)", errno }), ifindex: undefined };
    }

    const { ifr_ifru } = kernelAbi.ifreq.parse({ data: ifr });
    const { ifr_ifindex } = kernelAbi.ifru_ifindex.parse({ data: ifr_ifru });

    return { error: undefined, ifindex: Number(ifr_ifindex) };
  };

  const findInterfaceNameByIndexUsing = ({ fd, ifindex }: { fd: number, ifindex: number }): TFindInterfaceNameResult => {
    const ifr = formatIfreq({
      kernelAbi,
      interfaceName: "",
      ifru: kernelAbi.ifru_ifindex.format({ value: { ifr_ifindex: BigInt(ifindex) } })
    });

    const { errno } = po6.ioctl({ fd, request: constants.SIOCGIFNAME, args: [ifr] });

    if (errno === errnoCodes.ENODEV) {
      return { error: Error(`interface index ${ifindex} not found`), interfaceName: undefined };
    }

    if (errno !== undefined) {
      return { error: po6.createErrorFromErrno({ operation: "ioctl(SIOCGIFNAME)", errno }), interfaceName: undefined };
    }

    const { ifr_name: interfaceName } = kernelAbi.ifreq.parse({ data: ifr });

    return { error: undefined, interfaceName };
  };

  const findInterfaceIndexByName = ({ interfaceName }: { interfaceName: string }): TFindInterfaceIndexResult => {
    if (new TextEncoder().encode(interfaceName).length > maxInterfaceNameLength) {
      return { error: Error(`interface name "${interfaceName}" is longer than ${maxInterfaceNameLength} bytes`), ifindex: undefined };
    }

    const { error, result } = controlSocketRunner.withControlSocket({
      callback: ({ fd }) => {
        return findInterfaceIndexByNameUsing({ fd, interfaceName });
      }
    });

    if (error !== undefined) {
      return { error, ifindex: undefined };
    }

    return result;
  };

  return {
    findInterfaceIndexByName,
    findInterfaceNameByIndexUsing
  };
};

export type {
  TFindInterfaceIndexResult,
  TFindInterfaceNameResult
};

export {
  createInterfaceNames
};
