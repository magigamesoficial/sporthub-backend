import rateLimit from "express-rate-limit";

function json429(message: string) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: message,
        code: "RATE_LIMIT",
      });
    },
  });
}

/** Geração de captcha (evita abuso de CPU / tokens). */
export const authCaptchaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: "Muitas solicitações de captcha. Aguarde cerca de um minuto.",
      code: "RATE_LIMIT",
    });
  },
});

export const authRegisterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error:
        "Muitas tentativas de cadastro a partir deste endereço. Aguarde cerca de 15 minutos.",
      code: "RATE_LIMIT",
    });
  },
});

export const authLoginLimiter = json429(
  "Muitas tentativas de login. Aguarde alguns minutos e tente de novo.",
);
