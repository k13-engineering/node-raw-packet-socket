import { createPoller } from "@k13engineering/uv-poll";
import { pinBuffer } from "buffer2address";
import { createLinuxKernelInterface, type TLinuxKernelInterface, type TMemoryInterface } from "po6";
import { syscall, syscallNumbers } from "syscall-napi";
import type { TCreatePoller } from "./socket.ts";

// everything that talks to the kernel, passed in so tests can use a fake kernel
type TKernel = {
  // the syscalls po6 performs
  kernelInterface: TLinuxKernelInterface;
  // pins buffers whose addresses are passed to the kernel inside of structures
  memory: TMemoryInterface;
  // waits in the event loop for file descriptors to become readable or writable
  createPoller: TCreatePoller;
};

const createDefaultKernel = (): TKernel => {
  return {
    kernelInterface: createLinuxKernelInterface({ syscall, syscallNumbers }),
    memory: { pinBuffer },
    createPoller,
  };
};

export type {
  TKernel
};

export {
  createDefaultKernel
};
