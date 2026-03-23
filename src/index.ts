import "dotenv/config";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { prisma } from "./lib/prisma";
import { getJwtSecret } from "./lib/jwt";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { groupsRouter } from "./routes/groups";
import { legalRouter } from "./routes/legal";

if (process.env.NODE_ENV === "production") {
  try {
    getJwtSecret();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error(msg);
    process.exit(1);
  }
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
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
    version: "0.6.0",
    docs: "Grupos públicos: GET /groups/preview-code/:code, POST /groups/join-by-code, POST /groups/:id/join-requests; aprovação: GET/POST .../join-requests/:rid/approve|reject. Ver /groups/*, /auth/*, /admin/*.",
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
    await prisma.$queryRaw`SELECT 1 AS ok`;
    res.json({ ok: true, db: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "erro desconhecido";
    res.status(503).json({ ok: false, db: false, reason: message });
  }
});

app.use("/legal", legalRouter);
app.use("/auth", authRouter);
app.use("/groups", groupsRouter);
app.use("/admin", adminRouter);

const port = Number(process.env.PORT) || 4000;

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`SportHub API ouvindo na porta ${port}`);
});

function shutdown(signal: string) {
  // eslint-disable-next-line no-console
  console.log(`${signal} recebido, encerrando…`);
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
