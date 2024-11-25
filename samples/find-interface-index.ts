import { findInterfaceIndexByName } from "../lib/index.ts";


const { error, ifindex } = findInterfaceIndexByName({ interfaceName: "eth0" });

console.log({ error, ifindex });
