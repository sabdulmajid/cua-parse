import { mkdirSync, writeFileSync } from "node:fs";
import { fixtureRecords } from "../fixtures/acmeflow.js";
mkdirSync(".local", { recursive: true, mode: 0o700 });
writeFileSync(
  ".local/acmeflow-synthetic.json",
  JSON.stringify(fixtureRecords(), null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  "Wrote .local/acmeflow-synthetic.json. All records are synthetic. Use fixture mode, not import mode.",
);
