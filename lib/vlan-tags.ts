import type { TRawPacketKernelAbi } from "./kernel-abi.ts";
import type { TFrameRestorer } from "./socket-duplex.ts";

// the destination and the source address, after which the tag goes
const tagOffset = 12;

// Puts the outermost VLAN tag back into received frames, like libpcap does.
// The kernel takes it out of every frame it receives, also without hardware
// offload, and keeps it out of the frames it sends with tx-vlan-hw-insert.
// A packet socket only learns about it from struct tpacket_auxdata, which
// recvmsg() adds as control message once PACKET_AUXDATA is enabled.
const createVlanTagRestorer = ({ kernelAbi }: { kernelAbi: TRawPacketKernelAbi }): TFrameRestorer => {

  const { constants, controlMessageLayout } = kernelAbi;
  const auxdataSpace = controlMessageLayout.spaceFor({ dataLength: kernelAbi.tpacket_auxdata.size });

  // the only control message, as the socket enables no other
  const auxdataOf = ({ control }: { control: Uint8Array }) => {
    if (control.length < auxdataSpace) {
      return undefined;
    }

    const { cmsg_level, cmsg_type } = kernelAbi.cmsghdr.parse({ data: control });
    if (cmsg_level !== kernelAbi.po6.constants.SOL_PACKET || cmsg_type !== constants.PACKET_AUXDATA) {
      return undefined;
    }

    return kernelAbi.tpacket_auxdata.parse({ data: control.subarray(controlMessageLayout.dataOffset) });
  };

  const insertTag = ({ frame, tpid, tci }: { frame: Uint8Array, tpid: bigint, tci: bigint }) => {
    const tag = kernelAbi.vlan_tag.format({ value: { tpid, tci } });

    const tagged = new Uint8Array(frame.length + tag.length);
    tagged.set(frame.subarray(0, tagOffset));
    tagged.set(tag, tagOffset);
    tagged.set(frame.subarray(tagOffset), tagOffset + tag.length);

    return tagged;
  };

  const restore: TFrameRestorer["restore"] = ({ frame, control }) => {
    const auxdata = auxdataOf({ control });
    if (auxdata === undefined || (auxdata.tp_status & constants.TP_STATUS_VLAN_VALID) === 0n) {
      return frame;
    }

    return insertTag({ frame, tpid: auxdata.tp_vlan_tpid, tci: auxdata.tp_vlan_tci });
  };

  return {
    controlSize: auxdataSpace,
    restore
  };
};

export {
  createVlanTagRestorer
};
