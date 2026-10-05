import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "mocha";
import { createControlSocketRunner } from "./control-socket.ts";
import { createInterfaceNames } from "./interface-names.ts";
import {
  assertKernelClean,
  createTestEnvironment,
  errnoCodes,
  kernelAbi
} from "./test-support/environment.ts";
import type { TFakeKernel } from "./test-support/fake-kernel.ts";

const { constants } = kernelAbi;

describe("interface names", () => {

  let fakeKernel: TFakeKernel;
  let controlSocketRunner: ReturnType<typeof createControlSocketRunner>;
  let interfaceNames: ReturnType<typeof createInterfaceNames>;

  beforeEach(() => {
    const environment = createTestEnvironment({
      interfaces: [
        { ifindex: 1, name: "lo" },
        { ifindex: 7, name: "fifteen-bytes-1" },
      ]
    });

    fakeKernel = environment.fakeKernel;
    controlSocketRunner = createControlSocketRunner({ po6: environment.po6, kernelAbi });
    interfaceNames = createInterfaceNames({ po6: environment.po6, kernelAbi, controlSocketRunner });
  });

  afterEach(() => {
    assertKernelClean({ fakeKernel });
  });

  describe("findInterfaceIndexByName", () => {
    it("should find the index with SIOCGIFINDEX on a datagram socket", () => {
      assert.deepStrictEqual(interfaceNames.findInterfaceIndexByName({ interfaceName: "lo" }), { error: undefined, ifindex: 1 });

      assert.deepStrictEqual(fakeKernel.calls(), [
        { operation: "socket:AF_INET", type: constants.SOCK_DGRAM | constants.SOCK_CLOEXEC, protocol: 0n },
        { operation: "SIOCGIFINDEX", fd: 100 },
        { operation: "close", fd: 100 },
      ]);
    });

    it("should find interfaces with names of 15 bytes", () => {
      assert.deepStrictEqual(
        interfaceNames.findInterfaceIndexByName({ interfaceName: "fifteen-bytes-1" }),
        { error: undefined, ifindex: 7 }
      );
    });

    it("should report unknown interfaces", () => {
      const { error, ifindex } = interfaceNames.findInterfaceIndexByName({ interfaceName: "eth9" });

      assert.strictEqual(ifindex, undefined);
      assert.strictEqual(error?.message, `interface "eth9" not found`);
    });

    it("should reject names longer than 15 bytes without asking the kernel", () => {
      ["sixteen-bytes-12", "äöüäöüäö"].forEach((interfaceName) => {
        const { error, ifindex } = interfaceNames.findInterfaceIndexByName({ interfaceName });

        assert.strictEqual(ifindex, undefined);
        assert.strictEqual(error?.message, `interface name "${interfaceName}" is longer than 15 bytes`);
      });

      assert.deepStrictEqual(fakeKernel.calls(), []);
    });

    it("should report other errors of SIOCGIFINDEX", () => {
      fakeKernel.injectErrno({ operation: "SIOCGIFINDEX", errno: errnoCodes.EFAULT });

      const { error } = interfaceNames.findInterfaceIndexByName({ interfaceName: "lo" });

      assert.strictEqual(error?.message, "ioctl(SIOCGIFINDEX) failed with EFAULT: Bad address");
    });

    it("should report errors of creating the socket", () => {
      fakeKernel.injectErrno({ operation: "socket:AF_INET", errno: errnoCodes.EMFILE });

      const { error, ifindex } = interfaceNames.findInterfaceIndexByName({ interfaceName: "lo" });

      assert.strictEqual(ifindex, undefined);
      assert.strictEqual(error?.message, "socket() failed with EMFILE: Too many open files");
    });
  });

  describe("findInterfaceNameByIndexUsing", () => {
    const findInterfaceNameByIndex = ({ ifindex }: { ifindex: number }) => {
      const { result } = controlSocketRunner.withControlSocket({
        callback: ({ fd }) => {
          return interfaceNames.findInterfaceNameByIndexUsing({ fd, ifindex });
        }
      });

      assert.notStrictEqual(result, undefined);
      return result;
    };

    it("should find the name with SIOCGIFNAME", () => {
      assert.deepStrictEqual(findInterfaceNameByIndex({ ifindex: 7 }), { error: undefined, interfaceName: "fifteen-bytes-1" });
    });

    it("should report unknown interfaces", () => {
      const { error, interfaceName } = findInterfaceNameByIndex({ ifindex: 9 }) ?? {};

      assert.strictEqual(interfaceName, undefined);
      assert.strictEqual(error?.message, "interface index 9 not found");
    });

    it("should report other errors of SIOCGIFNAME", () => {
      fakeKernel.injectErrno({ operation: "SIOCGIFNAME", errno: errnoCodes.EFAULT });

      const { error } = findInterfaceNameByIndex({ ifindex: 1 }) ?? {};

      assert.strictEqual(error?.message, "ioctl(SIOCGIFNAME) failed with EFAULT: Bad address");
    });
  });
});
