import assert from "node:assert/strict";
import { describe, it } from "mocha";
import nodeChildProcess from "node:child_process";
import nodeFs from "node:fs/promises";
import nodeOs from "node:os";
import nodePath from "node:path";
import nodeUtil from "node:util";
import { compileAndCompare, type TAbi } from "ya-struct";
import {
  constants,
  createKernelAbiFor,
  defineIfreq,
  ethtool_value,
  ifmap,
  packet_mreq,
  sockaddr_ll,
} from "./kernel-abi.ts";

// x86_64 and arm64, the platforms the native dependencies are available for
const hostAbi: TAbi = {
  endianness: "little",
  compiler: "gcc",
  dataModel: "LP64",
};

const execFile = nodeUtil.promisify(nodeChildProcess.execFile);

const compileAndRun = async ({ sourceCode }: { sourceCode: string }): Promise<{ output: string }> => {
  const directory = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "raw-packet-socket-abi-"));
  try {
    const sourceFile = nodePath.join(directory, "main.c");
    const binaryFile = nodePath.join(directory, "main.out");
    await nodeFs.writeFile(sourceFile, sourceCode);
    await execFile("gcc", [sourceFile, "-o", binaryFile]);
    const { stdout } = await execFile(binaryFile, []);
    return { output: stdout };
  } finally {
    await nodeFs.rm(directory, { recursive: true });
  }
};

const globalCode = [
  "#include <net/if.h>",
  "#include <sys/socket.h>",
  "#include <linux/if_packet.h>",
  "#include <linux/if_ether.h>",
  "#include <linux/sockios.h>",
  "#include <linux/ethtool.h>",
].join("\n");

const assertLayoutMatches = async ({
  structDefinition,
  cStructName
}: {
  structDefinition: Parameters<typeof compileAndCompare>[0]["structDefinition"],
  cStructName: string
}) => {
  const { layoutErrors } = await compileAndCompare({
    structDefinition,
    abi: hostAbi,
    globalCode,
    cStructName,
    compileAndRun,
  });

  assert.deepStrictEqual(layoutErrors, [], `layout errors: ${JSON.stringify(layoutErrors, undefined, 2)}`);
};

describe("kernel ABI", () => {

  describe("structures", () => {
    it("should lay out struct sockaddr_ll like the kernel headers", async () => {
      await assertLayoutMatches({ structDefinition: sockaddr_ll.definition, cStructName: "sockaddr_ll" });
    }).timeout(30_000);

    it("should lay out struct packet_mreq like the kernel headers", async () => {
      await assertLayoutMatches({ structDefinition: packet_mreq.definition, cStructName: "packet_mreq" });
    }).timeout(30_000);

    it("should lay out struct ifmap like the C headers", async () => {
      await assertLayoutMatches({ structDefinition: ifmap.definition, cStructName: "ifmap" });
    }).timeout(30_000);

    it("should lay out struct ifreq like the C headers", async () => {
      await assertLayoutMatches({ structDefinition: defineIfreq({ machineAbi: hostAbi }).definition, cStructName: "ifreq" });
    }).timeout(30_000);

    it("should lay out struct ethtool_value like the kernel headers", async () => {
      await assertLayoutMatches({ structDefinition: ethtool_value.definition, cStructName: "ethtool_value" });
    }).timeout(30_000);

    it("should place the members of ifr_ifru like the C headers", async () => {
      const kernelAbi = createKernelAbiFor({ machineAbi: hostAbi });

      const { output } = await compileAndRun({
        sourceCode: `#include <stdio.h>
#include <stddef.h>
${globalCode}

int main(void) {
  struct ifreq ifr;
  printf("%zu %zu\\n", offsetof(struct ifreq, ifr_ifindex) - offsetof(struct ifreq, ifr_ifru), sizeof(ifr.ifr_ifindex));
  printf("%zu %zu\\n", offsetof(struct ifreq, ifr_data) - offsetof(struct ifreq, ifr_ifru), sizeof(ifr.ifr_data));
  return 0;
}
`
      });

      assert.strictEqual(output, [
        `0 ${kernelAbi.ifru_ifindex.size}`,
        `0 ${kernelAbi.ifru_data.size}`,
        "",
      ].join("\n"));
    }).timeout(30_000);
  });

  it("should use the values of the C headers for the constants", async () => {
    const names = Object.keys(constants);

    const printStatements = names.map((name) => {
      return `  printf("%s %lld\\n", "${name}", (long long) ${name});`;
    });

    const { output } = await compileAndRun({
      sourceCode: `#include <stdio.h>
${globalCode}

int main(void) {
${printStatements.join("\n")}
  return 0;
}
`
    });

    const expectedOutput = Object.entries(constants).map(([name, value]) => {
      return `${name} ${value}\n`;
    }).join("");

    assert.strictEqual(output, expectedOutput);
  }).timeout(30_000);
});
