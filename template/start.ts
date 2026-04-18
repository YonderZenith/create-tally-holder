import "dotenv/config";
import { run } from "./holder/daemon.js";

run().catch((err) => {
  console.error("[tally-holder] fatal:", err);
  process.exit(1);
});
