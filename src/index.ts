import "dotenv/config";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { closePool, getPool } from "./db";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const corsOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins =
  corsOrigins.length > 0
    ? corsOrigins
    : ["http://localhost:3000", "http://127.0.0.1:3000"];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "SportHub API",
    version: "0.1.0",
    docs: "Use /health e /health/db para verificar o serviço e o banco.",
  });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/health/db", async (_req: Request, res: Response) => {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ ok: false, db: false, reason: "DATABASE_URL ausente" });
    return;
  }

  try {
    const r = await getPool().query("SELECT 1 AS ok");
    res.json({ ok: true, db: true, result: r.rows[0] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "erro desconhecido";
    res.status(503).json({ ok: false, db: false, reason: message });
  }
});

const port = Number(process.env.PORT) || 4000;

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`SportHub API ouvindo na porta ${port}`);
});

function shutdown(signal: string) {
  // eslint-disable-next-line no-console
  console.log(`${signal} recebido, encerrando…`);
  server.close(() => {
    void closePool().finally(() => process.exit(0));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
