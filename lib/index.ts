import { create as createSocket } from "po6-socket";
import po6 from "po6";
import { createAndSteal as createDuplexAndSteal } from "./socket-duplex.ts";
import child_process from "node:child_process";
import duplexify from "duplexify";

const AF_PACKET = 17;
const SOCK_RAW = 3;
const IPPROTO_RAW = 255;

const AF_INET = 2;
const SOCK_DGRAM = 2;

const PACKET_HOST = 0;
const PACKET_BROADCAST = 1;
const PACKET_MULTICAST = 2;
const PACKET_OTHERHOST = 3;

const SIOCGIFINDEX = 0x8933;
const SIOCGIFNAME = 0x8910;
const IFNAMSIZ = 16;

let socketForInterfaceIndexAndNameResolution: number | undefined = undefined;

const maybeCreateSocketForInterfaceIndexAndNameResolution = () => {
    if (socketForInterfaceIndexAndNameResolution === undefined) {
        const { errno, fd } = po6.socket({
            domain: AF_INET,
            type: SOCK_DGRAM,
            protocol: 0
        });

        if (errno !== po6.errnoCodes.NO_ERROR) {
            throw po6.createErrorFromErrno({ operation: "socket()", errno });
        }

        socketForInterfaceIndexAndNameResolution = fd;
    }

    return socketForInterfaceIndexAndNameResolution;
};

const disableTcpSegmentationOffloadingUntilRebootByInterfaceName = async ({ interfaceName }): Promise<{ error: Error | undefined }> => {
    return await new Promise((resolve) => {
        child_process.exec(`ethtool -K ${interfaceName} tso off`, (error) => {
            if (error) {
                resolve({ error });
            } else {
                resolve({ error: undefined });
            }
        });
    });
};

const findInterfaceNameByIndex = ({ ifindex }) => {
    const fd = maybeCreateSocketForInterfaceIndexAndNameResolution();

    const ifr = Buffer.alloc(40);
    ifr.writeUInt32LE(ifindex, IFNAMSIZ);

    const { errno: ioctlErrno } = po6.ioctl({
        fd,
        request: SIOCGIFNAME,
        args: [ifr]
    });

    if (ioctlErrno !== po6.errnoCodes.NO_ERROR) {

        if (ioctlErrno === po6.errnoCodes.ENODEV) {
            return {
                error: Error(`interface index ${ifindex} not found`)
            };
        }

        return {
            error: po6.createErrorFromErrno({ operation: "ioctl()", errno: ioctlErrno })
        };
    }

    const paddedInterfaceNameAsBuffer = ifr.slice(0, IFNAMSIZ);
    const interfaceName = paddedInterfaceNameAsBuffer.toString("utf8").replace(/\0/g, "");

    return {
        error: undefined,
        interfaceName
    };
};

const createNodeDuplexByInterfaceIndex = ({
    ifindex,
    disableTcpSegmentationOffloadUntilReboot = false
}: {
    ifindex: number,
    disableTcpSegmentationOffloadUntilReboot?: boolean
}) => {

    const duplex = duplexify();

    // all errors should raise "error" events, therefore we do our work in a other task

    setTimeout(async () => {
        const { error: socketError, socket } = createSocket({
            domain: AF_PACKET,
            type: SOCK_RAW,
            protocol: IPPROTO_RAW,
        });

        if (socketError !== undefined) {
            duplex.destroy(socketError);
            return;
        }

        // TODO: fd leaks

        const sll_pkttype = PACKET_HOST;

        const sockaddr = Buffer.alloc(20);
        sockaddr.writeUInt16LE(AF_PACKET, 0); // sll_family
        sockaddr.writeUInt16LE(0x0300, 2);    // sll_protocol
        sockaddr.writeUInt16LE(ifindex, 4);   // sll_ifindex
        sockaddr.writeUInt16LE(sll_pkttype, 10);       // sll_hatype

        const { errno: bindErrno } = socket.bind({ sockaddr });
        if (bindErrno !== po6.errnoCodes.NO_ERROR) {
            const error = po6.createErrorFromErrno({ operation: "bind()", errno: bindErrno });
            duplex.destroy(error);
            return;
        }

        if (disableTcpSegmentationOffloadUntilReboot) {
            const { error: findNameError, interfaceName } = findInterfaceNameByIndex({ ifindex });
            if (findNameError !== undefined) {
                duplex.destroy(findNameError);
                return;
            }

            // RACE! interface name might change between we find it and call ethtool
            // TODO: use netlink

            const { error: disableTSOError } = await disableTcpSegmentationOffloadingUntilRebootByInterfaceName({
                interfaceName
            });
            if (disableTSOError !== undefined) {
                duplex.destroy(disableTSOError);
                return;
            }
        }

        const socketDuplex = createDuplexAndSteal({ socket });
        duplex.setReadable(socketDuplex);
        duplex.setWritable(socketDuplex);

        if (duplex.destroyed) {
            return;
        }
        duplex.emit("open");

        if (duplex.destroyed) {
            return;
        }
        duplex.emit("ready");
    }, 0);

    return duplex;
};

const findInterfaceIndexByName = ({ interfaceName }) => {

    const fd = maybeCreateSocketForInterfaceIndexAndNameResolution();

    const ifr = Buffer.alloc(40);
    ifr.write(interfaceName, 0, interfaceName.length);

    const { errno: ioctlErrno } = po6.ioctl({
        fd,
        request: SIOCGIFINDEX,
        args: [ifr]
    });

    if (ioctlErrno !== po6.errnoCodes.NO_ERROR) {

        if (ioctlErrno === po6.errnoCodes.ENODEV) {
            return {
                error: Error(`interface "${interfaceName}" not found`)
            };
        }

        return {
            error: po6.createErrorFromErrno({ operation: "ioctl()", errno: ioctlErrno })
        };
    }

    const ifindex = ifr.readUInt32LE(IFNAMSIZ);

    return {
        error: undefined,
        ifindex
    };
};

export {
    createNodeDuplexByInterfaceIndex,
    findInterfaceIndexByName
};
