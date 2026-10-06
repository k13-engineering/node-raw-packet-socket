import assert from "node:assert/strict";
import { describe, it } from "mocha";
import nodeChildProcess from "node:child_process";
import nodePath from "node:path";
import nodeProcess from "node:process";

// Runs the API against the real kernel. A user and network namespace of its
// own gives it CAP_NET_RAW and CAP_NET_ADMIN without root and without
// touching the interfaces of the host. Skipped where unprivileged user
// namespaces or iproute2 are not available.

const scriptPath = nodePath.join(import.meta.dirname, "test-support", "end-to-end-script.ts");

const runInNetworkNamespace = ({ script }: { script: string }) => {
  return nodeChildProcess.execFileSync("unshare", ["--user", "--map-root-user", "--net", "sh", "-c", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
};

const networkNamespacesAvailable = () => {
  try {
    runInNetworkNamespace({ script: "ip link add veth0 type veth peer name veth1" });
    return true;
  } catch {
    return false;
  }
};

const describeIfNamespaces = networkNamespacesAvailable() ? describe : describe.skip;

describeIfNamespaces("end to end", () => {

  it("should exchange frames over a veth pair with offloads disabled and in promiscuous mode", () => {
    const output = runInNetworkNamespace({
      script: [
        "ip link add veth0 type veth peer name veth1",
        "ip link set veth0 up",
        "ip link set veth1 up",
        `"${nodeProcess.execPath}" "${scriptPath}"`,
      ].join(" && ")
    });

    const result = JSON.parse(output);

    assert.strictEqual(result.received, "hello over veth");
    assert.strictEqual(result.receivedLength, 60);
    assert.strictEqual(result.promiscuity, 1);
    assert.strictEqual(result.promiscuityAfterClose, 0);

    if (result.offloads !== undefined) {
      assert.ok(result.offloads.length > 0);
      result.offloads.forEach((line: string) => {
        assert.match(line, /: off/);
      });
    }

    if (result.offloadsWithoutSocket !== undefined) {
      assert.deepStrictEqual(result.offloadsWithoutSocket, ["tx-checksumming: off"]);
    }
  }).timeout(30_000);
});
