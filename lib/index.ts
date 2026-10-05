import { hostAbi } from "po6";
import { createKernelAbiFor } from "./kernel-abi.ts";
import { createDefaultKernel } from "./kernel.ts";
import { createRawPacketSocketApi, type TRawPacketSocketApi } from "./raw-packet-socket-api.ts";

const rawPacketSocketApi = createRawPacketSocketApi({
  kernel: createDefaultKernel(),
  kernelAbi: createKernelAbiFor({ machineAbi: hostAbi })
});

// typed explicitly, so the declaration files do not fall back to any
const createNodeDuplexByInterfaceIndex: TRawPacketSocketApi["createNodeDuplexByInterfaceIndex"] =
  rawPacketSocketApi.createNodeDuplexByInterfaceIndex;

const findInterfaceIndexByName: TRawPacketSocketApi["findInterfaceIndexByName"] = rawPacketSocketApi.findInterfaceIndexByName;

export {
  createNodeDuplexByInterfaceIndex,
  findInterfaceIndexByName
};

export type { TCreateNodeDuplexByInterfaceIndexArgs } from "./raw-packet-socket-api.ts";
export type { TFindInterfaceIndexResult } from "./interface-names.ts";
