// Socket wrapper, imported from po6-socket and adjusted to the po6 0.1.0 API

import type {
  TBindResult,
  TErrorWithErrno,
  TPo6Api,
  TRecvmsgResult,
  TSendmsgResult,
  TSetsockoptResult
} from "po6";
import type { TRawPacketKernelAbi } from "./kernel-abi.ts";

// libuv reports POLLERR as UV_EBADF; a packet socket signals POLLERR when
// its interface goes down or away
const UV_EBADF = -9;

type TPollEvents = {
  error: (args: { errorCode: number }) => void;
  readable?: () => void;
  writable?: () => void;
};

// a poller that calls back once per arming, e.g. of @k13engineering/uv-poll
type TPoller = {
  armOnce: (events: TPollEvents) => void;
  disarm: () => void;
  close: () => void;
};

type TCreatePoller = (args: { fd: number }) => TPoller;

type TSocketEvents = {
  readable: boolean;
  writable: boolean;
};

type TSocketPoller = {
  update: (args: { events: TSocketEvents }) => void;
  close: () => void;
};

type TSocket = {
  bind: (args: { sockaddr: Uint8Array }) => TBindResult;
  recvmsg: (args: { data: Uint8Array, control?: Uint8Array }) => TRecvmsgResult;
  sendmsg: (args: { data: Uint8Array }) => TSendmsgResult;
  poller: (args: {
    callback: (args: { events: TSocketEvents }) => void,
    onError: (args: { error: Error }) => void
  }) => TSocketPoller;
  sockopt: {
    packet: {
      addMembership: (args: { ifindex: number, action: bigint, address?: Uint8Array }) => TSetsockoptResult;
      setInt: (args: { optname: bigint, value: number }) => TSetsockoptResult;
    };
  };
  close: () => void;
};

type TCreateSocketResult = {
  error: TErrorWithErrno;
  socket: undefined;
} | {
  error: undefined;
  socket: TSocket;
};

const errorFromPollErrorCode = ({ errorCode }: { errorCode: number }) => {
  if (errorCode === UV_EBADF) {
    return Error("interface went down");
  }

  return Error(`polling the socket failed with libuv error ${errorCode}`);
};

const createSocketFactory = ({
  po6,
  kernelAbi,
  createPoller
}: {
  po6: TPo6Api,
  kernelAbi: TRawPacketKernelAbi,
  createPoller: TCreatePoller
}) => {

  const createPacketSocketOptions = ({ fd }: { fd: number }) => {

    const addMembership: TSocket["sockopt"]["packet"]["addMembership"] = ({ ifindex, action, address = new Uint8Array(0) }) => {
      const mr_address = new Uint8Array(8);
      mr_address.set(address);

      const mreq = kernelAbi.packet_mreq.format({
        value: {
          mr_ifindex: BigInt(ifindex),
          mr_type: action,
          mr_alen: BigInt(address.length),
          mr_address,
        }
      });

      return po6.setsockopt({
        fd,
        level: kernelAbi.po6.constants.SOL_PACKET,
        optname: kernelAbi.po6.constants.PACKET_ADD_MEMBERSHIP,
        optval: mreq
      });
    };

    const setInt: TSocket["sockopt"]["packet"]["setInt"] = ({ optname, value }) => {
      return po6.setsockopt({
        fd,
        level: kernelAbi.po6.constants.SOL_PACKET,
        optname,
        optval: kernelAbi.sockopt_int.format({ value: { value: BigInt(value) } })
      });
    };

    return {
      addMembership,
      setInt
    };
  };

  // takes ownership of fd
  const wrapFd = ({ fd }: { fd: number }): TSocket => {

    let pollerInstance: TPoller | undefined = undefined;

    const bind: TSocket["bind"] = ({ sockaddr }) => {
      return po6.bind({ fd, sockaddr });
    };

    const recvmsg: TSocket["recvmsg"] = ({ data, control }) => {
      return po6.recvmsg({ fd, data, msghdr: { msg_control: control } });
    };

    const sendmsg: TSocket["sendmsg"] = ({ data }) => {
      return po6.sendmsg({ fd, data });
    };

    const poller: TSocket["poller"] = ({ callback, onError }) => {
      if (pollerInstance !== undefined) {
        throw Error("poller already exists");
      }

      const instance = createPoller({ fd });
      pollerInstance = instance;

      const readable = () => {
        callback({ events: { readable: true, writable: false } });
      };

      const writable = () => {
        callback({ events: { readable: false, writable: true } });
      };

      const error: TPollEvents["error"] = ({ errorCode }) => {
        onError({ error: errorFromPollErrorCode({ errorCode }) });
      };

      const pollEventsFor = ({ events }: { events: TSocketEvents }): TPollEvents => {
        return {
          readable: events.readable ? readable : undefined,
          writable: events.writable ? writable : undefined,
          error
        };
      };

      // the poller fires once per arming, so every update arms it again
      const update: TSocketPoller["update"] = ({ events }) => {
        if (!events.readable && !events.writable) {
          instance.disarm();
          return;
        }

        instance.armOnce(pollEventsFor({ events }));
      };

      const close = () => {
        instance.close();
        pollerInstance = undefined;
      };

      return {
        update,
        close
      };
    };

    const close = () => {
      pollerInstance?.close();
      pollerInstance = undefined;
      po6.close({ fd });
    };

    return {
      bind,
      recvmsg,
      sendmsg,
      poller,
      sockopt: {
        packet: createPacketSocketOptions({ fd })
      },
      close,
    };
  };

  const create = ({
    domain,
    type,
    protocol
  }: {
    domain: bigint,
    type: bigint,
    protocol: bigint
  }): TCreateSocketResult => {
    const { errno, fd } = po6.socket({ domain, type, protocol });

    if (errno !== undefined) {
      return {
        error: po6.createErrorFromErrno({ operation: "socket()", errno }),
        socket: undefined
      };
    }

    return {
      error: undefined,
      socket: wrapFd({ fd })
    };
  };

  return {
    create
  };
};

export type {
  TCreatePoller,
  TPoller,
  TPollEvents,
  TSocket,
  TSocketEvents,
  TSocketPoller,
};

export {
  createSocketFactory
};
