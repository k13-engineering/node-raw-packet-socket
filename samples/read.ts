import {
  findInterfaceIndexByName,
  createNodeDuplexByInterfaceIndex
} from "../lib/index.ts";

const { error: findError, ifindex } = findInterfaceIndexByName({ interfaceName: "eth0" });
if (findError !== undefined) {
  throw findError;
}

const duplex = createNodeDuplexByInterfaceIndex({
  ifindex,
  disableTcpSegmentationOffloadUntilReboot: true
});

duplex.on("error", (err) => {
  console.error("my error", err);
});

duplex.on("data", (packet) => {
  console.log({ packet });
});
