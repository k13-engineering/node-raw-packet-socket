import assert from "node:assert/strict";
import { afterEach, describe, it } from "mocha";
import { createControlSocketRunner } from "./control-socket.ts";
import { createEthtool, type TOffloadName } from "./ethtool.ts";
import {
  assertKernelClean,
  createTestEnvironment,
  defined,
  errnoCodes,
  kernelAbi
} from "./test-support/environment.ts";
import {
  createDefaultFeatures,
  type TFakeFeature,
  type TFakeKernel
} from "./test-support/fake-kernel.ts";

const tsoFeatureNames = [
  "tx-tcp-segmentation",
  "tx-tcp-ecn-segmentation",
  "tx-tcp-mangleid-segmentation",
  "tx-tcp6-segmentation",
  "tx-tcp-accecn-segmentation",
];

// the default features with some of them changed
const featuresWith = ({ changes }: { changes: { [name: string]: Partial<TFakeFeature> } }) => {
  return createDefaultFeatures().map((feature) => {
    return { ...feature, ...changes[feature.name] };
  });
};

const tsoFeaturesWith = ({ change }: { change: Partial<TFakeFeature> }) => {
  return featuresWith({
    changes: Object.fromEntries(tsoFeatureNames.map((name) => {
      return [name, change];
    }))
  });
};

describe("ethtool", () => {

  let fakeKernel: TFakeKernel;

  afterEach(() => {
    assertKernelClean({ fakeKernel });
  });

  const setup = ({ features, hidesFeatureNames }: { features?: TFakeFeature[], hidesFeatureNames?: boolean } = {}) => {
    const environment = createTestEnvironment({
      interfaces: [{ ifindex: 2, name: "eth0", features, hidesFeatureNames }]
    });

    fakeKernel = environment.fakeKernel;

    const controlSocketRunner = createControlSocketRunner({ po6: environment.po6, kernelAbi });
    const ethtool = createEthtool({ po6: environment.po6, kernelAbi, memory: fakeKernel.kernel.memory });

    const disableOffloads = ({ offloads, interfaceName = "eth0" }: { offloads: TOffloadName[], interfaceName?: string }) => {
      const { result } = controlSocketRunner.withControlSocket({
        callback: ({ fd }) => {
          return ethtool.disableOffloads({ fd, interfaceName, offloads });
        }
      });

      return defined({ value: result });
    };

    const activeFeatures = () => {
      return fakeKernel.interfaceState({ name: "eth0" }).activeFeatures;
    };

    const ethtoolCommands = () => {
      return fakeKernel.calls().filter((call) => {
        return call.operation.startsWith("ETHTOOL_");
      }).map((call) => {
        return call.operation;
      });
    };

    return {
      disableOffloads,
      activeFeatures,
      ethtoolCommands
    };
  };

  describe("disabling offloads", () => {
    it("should turn off all TCP segmentation features, as ethtool -K tso off does", () => {
      const { disableOffloads, activeFeatures, ethtoolCommands } = setup();

      assert.deepStrictEqual(disableOffloads({ offloads: ["tcp-segmentation-offload"] }), { error: undefined });

      // tx-tcp-accecn-segmentation is the 34th feature, in the second block
      assert.deepStrictEqual(activeFeatures(), ["tx-generic-segmentation", "rx-gro"]);
      assert.deepStrictEqual(ethtoolCommands(), [
        "ETHTOOL_GSSET_INFO",
        "ETHTOOL_GSTRINGS",
        "ETHTOOL_GTSO",
        "ETHTOOL_GFEATURES",
        "ETHTOOL_SFEATURES",
        "ETHTOOL_GTSO",
        "ETHTOOL_GFEATURES",
      ]);
    });

    it("should turn off generic segmentation offload", () => {
      const { disableOffloads, activeFeatures } = setup();

      assert.deepStrictEqual(disableOffloads({ offloads: ["generic-segmentation-offload"] }), { error: undefined });

      const expected = createDefaultFeatures().filter((feature) => {
        return feature.active && feature.name !== "tx-generic-segmentation";
      }).map((feature) => {
        return feature.name;
      });

      assert.deepStrictEqual(activeFeatures(), expected);
    });

    it("should turn off generic receive offload, but not the features it is a prefix of", () => {
      const { disableOffloads, activeFeatures } = setup({
        features: featuresWith({
          changes: {
            "rx-gro-hw": { active: true, changeable: true },
            "rx-gro-list": { active: true, changeable: true },
          }
        })
      });

      assert.deepStrictEqual(disableOffloads({ offloads: ["generic-receive-offload"] }), { error: undefined });

      assert.ok(!activeFeatures().includes("rx-gro"));
      assert.ok(activeFeatures().includes("rx-gro-hw"));
      assert.ok(activeFeatures().includes("rx-gro-list"));
    });

    it("should find features beyond the first block of 32", () => {
      const filler = Array.from({ length: 40 }).map((_, index) => {
        return { name: `feature-${index}`, active: true, changeable: true };
      });

      const { disableOffloads, activeFeatures } = setup({
        features: [...filler, { name: "rx-gro", active: true, changeable: true }]
      });

      assert.deepStrictEqual(disableOffloads({ offloads: ["generic-receive-offload"] }), { error: undefined });

      assert.deepStrictEqual(activeFeatures(), filler.map((feature) => {
        return feature.name;
      }));
    });

    it("should turn off several offloads", () => {
      const { disableOffloads, activeFeatures } = setup();

      const offloads: TOffloadName[] = ["tcp-segmentation-offload", "generic-segmentation-offload", "generic-receive-offload"];
      assert.deepStrictEqual(disableOffloads({ offloads }), { error: undefined });

      assert.deepStrictEqual(activeFeatures(), []);
    });

    it("should not talk to the kernel without offloads", () => {
      const { disableOffloads, ethtoolCommands } = setup();

      assert.deepStrictEqual(disableOffloads({ offloads: [] }), { error: undefined });

      assert.deepStrictEqual(ethtoolCommands(), []);
    });
  });

  describe("features the device does not allow changing", () => {
    it("should succeed if they are off already", () => {
      const { disableOffloads, activeFeatures } = setup({ features: tsoFeaturesWith({ change: { active: false, changeable: false } }) });

      assert.deepStrictEqual(disableOffloads({ offloads: ["tcp-segmentation-offload"] }), { error: undefined });

      assert.deepStrictEqual(activeFeatures(), ["tx-generic-segmentation", "rx-gro"]);
    });

    it("should fail if they are on", () => {
      const { disableOffloads } = setup({ features: tsoFeaturesWith({ change: { changeable: false } }) });

      const { error } = disableOffloads({ offloads: ["tcp-segmentation-offload"] });

      assert.strictEqual(error?.message, `could not disable tcp-segmentation-offload of interface "eth0"`);
    });

    it("should stop at the first offload that fails", () => {
      const { disableOffloads, activeFeatures } = setup({ features: tsoFeaturesWith({ change: { changeable: false } }) });

      const { error } = disableOffloads({ offloads: ["tcp-segmentation-offload", "generic-receive-offload"] });

      assert.notStrictEqual(error, undefined);
      assert.ok(activeFeatures().includes("rx-gro"));
    });

    it("should succeed like ethtool if other features of the offload changed", () => {
      const { disableOffloads, activeFeatures } = setup({
        features: featuresWith({ changes: { "tx-tcp-mangleid-segmentation": { changeable: false } } })
      });

      assert.deepStrictEqual(disableOffloads({ offloads: ["tcp-segmentation-offload"] }), { error: undefined });

      assert.deepStrictEqual(activeFeatures(), ["tx-generic-segmentation", "rx-gro", "tx-tcp-mangleid-segmentation"]);
    });

    it("should leave features alone that never change", () => {
      const { disableOffloads, activeFeatures } = setup({
        features: featuresWith({ changes: { "tx-tcp6-segmentation": { neverChanged: true } } })
      });

      assert.deepStrictEqual(disableOffloads({ offloads: ["tcp-segmentation-offload"] }), { error: undefined });

      assert.ok(activeFeatures().includes("tx-tcp6-segmentation"));
    });
  });

  describe("errors", () => {
    const failingCommands = [
      { operation: "ETHTOOL_GSSET_INFO", skip: 0 },
      { operation: "ETHTOOL_GSTRINGS", skip: 0 },
      { operation: "ETHTOOL_GTSO", skip: 0 },
      { operation: "ETHTOOL_GFEATURES", skip: 0 },
      { operation: "ETHTOOL_SFEATURES", skip: 0 },
      { operation: "ETHTOOL_GTSO", skip: 1 },
      { operation: "ETHTOOL_GFEATURES", skip: 1 },
    ];

    failingCommands.forEach(({ operation, skip }) => {
      it(`should report errors of ${operation}${skip > 0 ? " after the change" : ""}`, () => {
        const { disableOffloads } = setup();
        fakeKernel.injectErrno({ operation, errno: errnoCodes.EPERM, skip });

        const { error } = disableOffloads({ offloads: ["tcp-segmentation-offload"] });

        assert.strictEqual(error?.message, `ioctl(SIOCETHTOOL, ${operation}) failed with EPERM: Operation not permitted`);
      });
    });

    it("should report interfaces without feature names", () => {
      const { disableOffloads } = setup({ hidesFeatureNames: true });

      const { error } = disableOffloads({ offloads: ["generic-receive-offload"] });

      assert.strictEqual(error?.message, `interface "eth0" has no feature names`);
    });

    it("should report unknown interfaces", () => {
      const { disableOffloads } = setup();

      const { error } = disableOffloads({ offloads: ["generic-receive-offload"], interfaceName: "eth1" });

      assert.strictEqual(error?.message, "ioctl(SIOCETHTOOL, ETHTOOL_GSSET_INFO) failed with ENODEV: No such device");
    });
  });
});
