import { createPoller } from "@k13engineering/uv-poll";
import { pinBuffer } from "buffer2address";
import { createLinuxKernelInterface, createPo6Api, hostAbi } from "po6";
import { syscall, syscallNumbers } from "syscall-napi";
import { createKernelAbiFor } from "./kernel-abi.ts";
import { createRawPacketSocketApi } from "./raw-packet-socket-api.ts";

const kernelAbi = createKernelAbiFor({ machineAbi: hostAbi });

const po6 = createPo6Api({
  kernelInterface: createLinuxKernelInterface({ syscall, syscallNumbers }),
  kernelAbi: kernelAbi.po6,
  memory: { pinBuffer },
});

const {
  createNodeDuplexByInterfaceIndex,
  findInterfaceIndexByName
} = createRawPacketSocketApi({ po6, kernelAbi, createPoller });

export {
  createNodeDuplexByInterfaceIndex,
  findInterfaceIndexByName
};

export type { TCreateNodeDuplexByInterfaceIndexArgs } from "./raw-packet-socket-api.ts";
