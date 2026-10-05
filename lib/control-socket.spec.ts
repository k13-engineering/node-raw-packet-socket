import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "mocha";
import { createControlSocketRunner, formatIfreq } from "./control-socket.ts";
import { assertKernelClean, createTestEnvironment, kernelAbi } from "./test-support/environment.ts";
import type { TFakeKernel } from "./test-support/fake-kernel.ts";

describe("control socket", () => {

  let fakeKernel: TFakeKernel;
  let controlSocketRunner: ReturnType<typeof createControlSocketRunner>;

  beforeEach(() => {
    const environment = createTestEnvironment();
    fakeKernel = environment.fakeKernel;
    controlSocketRunner = createControlSocketRunner({ po6: environment.po6, kernelAbi });
  });

  afterEach(() => {
    assertKernelClean({ fakeKernel });
  });

  it("should pass a socket to the callback and return its result", () => {
    const { error, result } = controlSocketRunner.withControlSocket({
      callback: ({ fd }) => {
        assert.deepStrictEqual(fakeKernel.openFds(), [fd]);
        return "result";
      }
    });

    assert.strictEqual(error, undefined);
    assert.strictEqual(result, "result");
  });

  it("should close the socket when the callback throws", () => {
    assert.throws(() => {
      controlSocketRunner.withControlSocket({
        callback: () => {
          throw Error("callback failed");
        }
      });
    }, /callback failed/);
  });

  it("should format struct ifreq with a member of the union", () => {
    const ifru = kernelAbi.ifru_ifindex.format({ value: { ifr_ifindex: 3n } });

    const ifr = formatIfreq({ kernelAbi, interfaceName: "eth0", ifru });

    assert.strictEqual(ifr.length, kernelAbi.ifreq.size);

    const { ifr_name, ifr_ifru } = kernelAbi.ifreq.parse({ data: ifr });
    assert.strictEqual(ifr_name, "eth0");
    assert.strictEqual(ifr_ifru.length, kernelAbi.ifmap.size);
    assert.strictEqual(kernelAbi.ifru_ifindex.parse({ data: ifr_ifru }).ifr_ifindex, 3n);
    assert.deepStrictEqual(ifr_ifru.subarray(ifru.length), new Uint8Array(kernelAbi.ifmap.size - ifru.length));
  });
});
