import assert from "node:assert/strict";
import { createPo6Api, hostAbi } from "po6";
import { createKernelAbiFor } from "../kernel-abi.ts";
import { createFakeKernel, type TFakeKernel } from "./fake-kernel.ts";

const kernelAbi = createKernelAbiFor({ machineAbi: hostAbi });
const { errnoCodes } = kernelAbi.po6;

// a fake kernel and the real po6 on top of it
const createTestEnvironment = ({ interfaces }: { interfaces?: Parameters<typeof createFakeKernel>[0]["interfaces"] } = {}) => {
  const fakeKernel = createFakeKernel({ kernelAbi, interfaces });

  const po6 = createPo6Api({
    kernelInterface: fakeKernel.kernel.kernelInterface,
    kernelAbi: kernelAbi.po6,
    memory: fakeKernel.kernel.memory
  });

  return {
    fakeKernel,
    po6
  };
};

// nothing leaked and nothing done the kernel would not like
const assertKernelClean = ({ fakeKernel }: { fakeKernel: TFakeKernel }) => {
  assert.deepStrictEqual(fakeKernel.violations(), []);
  assert.deepStrictEqual(fakeKernel.openFds(), []);
  assert.strictEqual(fakeKernel.pinnedBufferCount(), 0);
};

// an ethernet frame with an experimental ethertype and the payload
const createFrame = ({ payload, length = 60 }: { payload: string, length?: number }) => {
  const frame = new Uint8Array(length);
  frame.set([0x02, 0, 0, 0, 0, 0x01, 0x02, 0, 0, 0, 0, 0x02, 0x88, 0xb5]);
  frame.set(new TextEncoder().encode(payload), 14);
  return frame;
};

const defined = <T>({ value }: { value: T | undefined }): T => {
  assert.notStrictEqual(value, undefined);
  return value as T;
};

export {
  kernelAbi,
  errnoCodes,
  createTestEnvironment,
  assertKernelClean,
  createFrame,
  defined
};
