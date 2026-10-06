import assert from "node:assert/strict";
import { describe, it } from "mocha";
import {
  createNodeDuplexByInterfaceIndex,
  disableOffloadsUntilReboot,
  findInterfaceIndexByName
} from "./index.ts";
import { errnoCodes } from "./test-support/environment.ts";

describe("index", () => {

  it("should find interfaces of the host", () => {
    // loopback is the first interface of every network namespace
    assert.deepStrictEqual(findInterfaceIndexByName({ interfaceName: "lo" }), { error: undefined, ifindex: 1 });
    assert.strictEqual(findInterfaceIndexByName({ interfaceName: "no-such-if" }).error?.message, `interface "no-such-if" not found`);
  });

  it("should disable offloads with the kernel of the host", () => {
    // an interface that does not exist, so the host stays as it is
    const { error } = disableOffloadsUntilReboot({ ifindex: 0x7fff_ffff, offloads: ["generic-receive-offload"] });

    assert.strictEqual(error?.message, "interface index 2147483647 not found");
  });

  it("should open a packet socket on the loopback interface, or fail without CAP_NET_RAW", async () => {
    const duplex = createNodeDuplexByInterfaceIndex({ ifindex: 1 });

    const outcome = await new Promise<{ error: Error & { errno?: number } | undefined }>((resolve) => {
      duplex.once("ready", () => {
        resolve({ error: undefined });
      });
      duplex.once("error", (error) => {
        resolve({ error });
      });
    });

    if (outcome.error !== undefined) {
      assert.strictEqual(outcome.error.errno, errnoCodes.EPERM, outcome.error.message);
      return;
    }

    const duplexClosed = new Promise((resolve) => {
      duplex.once("close", resolve);
    });
    duplex.destroy();
    await duplexClosed;
  });
});
