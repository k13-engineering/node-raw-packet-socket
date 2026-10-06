import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { createFrame, kernelAbi, tagFrame } from "./test-support/environment.ts";
import { createVlanTagRestorer } from "./vlan-tags.ts";

const { constants, controlMessageLayout } = kernelAbi;

const TP_STATUS_USER = 0x01n;
const TP_STATUS_VLAN_TPID_VALID = 0x40n;

const auxdataLength = kernelAbi.tpacket_auxdata.size;

// the control message recvmsg() returns with PACKET_AUXDATA enabled
const auxdataControl = ({
  cmsgType,
  status,
  vlan
}: {
  cmsgType: bigint,
  status: bigint,
  vlan: { tpid: bigint, tci: bigint }
}) => {
  const control = new Uint8Array(controlMessageLayout.spaceFor({ dataLength: auxdataLength }));

  control.set(kernelAbi.cmsghdr.format({
    value: {
      cmsg_len: BigInt(controlMessageLayout.lengthFor({ dataLength: auxdataLength })),
      cmsg_level: kernelAbi.po6.constants.SOL_PACKET,
      cmsg_type: cmsgType,
    }
  }));

  control.set(kernelAbi.tpacket_auxdata.format({
    value: {
      tp_status: status,
      tp_len: 60n,
      tp_snaplen: 60n,
      tp_mac: 0n,
      tp_net: 14n,
      tp_vlan_tci: vlan.tci,
      tp_vlan_tpid: vlan.tpid,
    }
  }), controlMessageLayout.dataOffset);

  return control;
};

// for a frame the kernel took the tag out of
const taggedControl = ({ tpid, tci, cmsgType = constants.PACKET_AUXDATA }: { tpid: bigint, tci: bigint, cmsgType?: bigint }) => {
  return auxdataControl({
    cmsgType,
    status: TP_STATUS_USER | constants.TP_STATUS_VLAN_VALID | TP_STATUS_VLAN_TPID_VALID,
    vlan: { tpid, tci }
  });
};

const untaggedControl = () => {
  return auxdataControl({ cmsgType: constants.PACKET_AUXDATA, status: TP_STATUS_USER, vlan: { tpid: 0n, tci: 0n } });
};

describe("VLAN tags", () => {

  const restorer = createVlanTagRestorer({ kernelAbi });
  const frame = createFrame({ payload: "untagged by the kernel" });

  it("should ask for room for the auxdata", () => {
    assert.strictEqual(restorer.controlSize, controlMessageLayout.spaceFor({ dataLength: auxdataLength }));
  });

  it("should put the 802.1Q tag back between the addresses and the ethertype", () => {
    // priority 1, VLAN 42
    const control = taggedControl({ tpid: 0x8100n, tci: 0x202an });

    assert.deepStrictEqual(restorer.restore({ frame, control }), tagFrame({ frame, tci: 0x202a }));
  });

  it("should put an 802.1ad tag back with its TPID", () => {
    const control = taggedControl({ tpid: 0x88a8n, tci: 100n });

    assert.deepStrictEqual(restorer.restore({ frame, control }), tagFrame({ frame, tpid: 0x88a8, tci: 100 }));
  });

  it("should put back the tags of priority tagged frames, which have VLAN 0", () => {
    const control = taggedControl({ tpid: 0x8100n, tci: 0n });

    assert.deepStrictEqual(restorer.restore({ frame, control }), tagFrame({ frame, tci: 0 }));
  });

  it("should leave frames without tag alone", () => {
    assert.strictEqual(restorer.restore({ frame, control: untaggedControl() }), frame);
  });

  it("should leave frames alone without auxdata", () => {
    assert.strictEqual(restorer.restore({ frame, control: new Uint8Array(0) }), frame);
  });

  it("should leave frames alone with another control message", () => {
    const control = taggedControl({ tpid: 0x8100n, tci: 42n, cmsgType: 0x7fffn });

    assert.strictEqual(restorer.restore({ frame, control }), frame);
  });
});
