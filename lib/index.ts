import { hostAbi } from "po6";
import { createKernelAbiFor } from "./kernel-abi.ts";
import { createDefaultKernel } from "./kernel.ts";
import { createRawPacketSocketApi } from "./raw-packet-socket-api.ts";

const {
  createNodeDuplexByInterfaceIndex,
  findInterfaceIndexByName
} = createRawPacketSocketApi({
  kernel: createDefaultKernel(),
  kernelAbi: createKernelAbiFor({ machineAbi: hostAbi })
});

export {
  createNodeDuplexByInterfaceIndex,
  findInterfaceIndexByName
};

export type { TCreateNodeDuplexByInterfaceIndexArgs } from "./raw-packet-socket-api.ts";
