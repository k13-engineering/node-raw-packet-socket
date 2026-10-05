import assert from "node:assert/strict";
import { after, describe, it } from "mocha";
import nodeChildProcess from "node:child_process";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import nodeProcess from "node:process";

const projectRoot = nodePath.resolve(import.meta.dirname, "..");

const buildPackage = ({ outDirectory }: { outDirectory: string }) => {
  nodeChildProcess.execFileSync(nodePath.join(projectRoot, "node_modules", ".bin", "deno-node-build"), [
    "--root", projectRoot,
    "--out", `${outDirectory}/`,
    "--entry", "lib/index.ts",
  ], { stdio: "pipe" });

  // let the built files resolve the package dependencies
  nodeFs.symlinkSync(nodePath.join(projectRoot, "node_modules"), nodePath.join(outDirectory, "node_modules"));
};

// a consumer of the built package, which must type-check against its declaration files
const consumerSource = `import {
  createNodeDuplexByInterfaceIndex,
  findInterfaceIndexByName,
  type TCreateNodeDuplexByInterfaceIndexArgs
} from "./lib/index.js";

const result = findInterfaceIndexByName({ interfaceName: "lo" });
if (result.error === undefined) {
  const ifindex: number = result.ifindex;
  const args: TCreateNodeDuplexByInterfaceIndexArgs = { ifindex, enablePromiscuousMode: true };
  createNodeDuplexByInterfaceIndex(args).destroy();
}

// @ts-expect-error the declarations must not fall back to any
findInterfaceIndexByName({ interfaceName: 1 });
`;

// The published package is the transpiled JavaScript in dist/, while the
// other specs run the TypeScript sources. Build the package like the
// release does and make sure the output loads, works and is typed.
describe("built package", () => {

  const outDirectory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "raw-packet-socket-build-"));
  let built = false;

  const ensureBuilt = () => {
    if (!built) {
      buildPackage({ outDirectory });
      built = true;
    }
  };

  after(() => {
    nodeFs.rmSync(outDirectory, { recursive: true, force: true });
  });

  it("should only contain JavaScript that parses", () => {
    ensureBuilt();

    const builtFiles = nodeFs.readdirSync(nodePath.join(outDirectory, "lib"), { recursive: true, encoding: "utf8" }).filter((file) => {
      return file.endsWith(".js");
    });

    assert.ok(builtFiles.length > 0);

    for (const file of builtFiles) {
      nodeChildProcess.execFileSync(nodeProcess.execPath, ["--check", nodePath.join(outDirectory, "lib", file)], { stdio: "pipe" });
    }
  }).timeout(60_000);

  it("should load and find interfaces", async () => {
    ensureBuilt();

    const builtIndex = await import(nodePath.join(outDirectory, "lib", "index.js")) as typeof import("./index.ts");

    assert.deepStrictEqual(builtIndex.findInterfaceIndexByName({ interfaceName: "lo" }), { error: undefined, ifindex: 1 });
  }).timeout(60_000);

  it("should provide declarations that type-check for consumers", () => {
    ensureBuilt();

    nodeFs.writeFileSync(nodePath.join(outDirectory, "consumer.ts"), consumerSource);
    nodeFs.writeFileSync(nodePath.join(outDirectory, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        types: ["node"],
      },
      files: ["consumer.ts"],
    }));

    nodeChildProcess.execFileSync(nodePath.join(projectRoot, "node_modules", ".bin", "tsc"), ["-p", outDirectory], { stdio: "pipe" });
  }).timeout(60_000);
});
