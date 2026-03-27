/**
 * `migrate reset` contra Postgres no Render a partir do Windows às vezes falha com P1017.
 * Forçar IPv4 no Node costuma estabilizar a conexão (ver .env.example).
 */
import { spawnSync } from "node:child_process";

const extra = "--dns-result-order=ipv4first";
const prev = process.env.NODE_OPTIONS ?? "";
process.env.NODE_OPTIONS = prev.includes("dns-result-order") ? prev : `${prev} ${extra}`.trim();

const r = spawnSync("npx", ["prisma", "migrate", "reset", "--force"], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

process.exit(r.status === null ? 1 : r.status);
