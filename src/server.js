// src/server.js
import express from "express";
import crypto from "crypto";
import axios from "axios";

import { APP } from "../config/env.js";
import { getCardCodeByCNPJ_HANA, searchTiresByAroMedida_HANA } from "../db/hana.js";
import { normalizeCNPJNumeric } from "../utils/cnpj.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * Logging (sem echo endpoint)
 * - requestId
 * - method/path/status/ms/ip
 * - body SANITIZADO apenas em rotas relevantes
 * - nunca loga Authorization / tokens
 */
function maskCnpj(cnpj) {
  const d = String(cnpj || "").replace(/\D/g, "");
  if (d.length !== 14) return cnpj;
  return `***${d.slice(8, 12)}-${d.slice(12)}`; // mostra só o final
}

function sanitizeBody(path, body) {
  const b = body ? { ...body } : {};

  if (b.cnpj) b.cnpj = maskCnpj(b.cnpj);

  if (path === "/customer/lookup") {
    return { cnpj: b.cnpj, conversationId: b.conversationId };
  }

  if (path === "/products/search-tires") {
    return { aro: b.aro, medida: b.medida };
  }

  if (path === "/budget/start") {
    return {
      cardCode: b.cardCode,
      itemCode: b.itemCode,
      clientRef: b.clientRef,
      conversationId: b.conversationId,
    };
  }

  if (path === "/budget/webhook") {
    return {
      transitionId: b.transitionId,
      status: b.status,
      resultKeys: b.result ? Object.keys(b.result) : [],
    };
  }

  return { keys: Object.keys(b) };
}

app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  req.requestId = requestId;

  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;

    const log = {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms,
      ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    };

    const interestingPaths = [
      "/customer/lookup",
      "/products/search-tires",
      "/budget/start",
      "/budget/webhook",
    ];
    if (interestingPaths.includes(req.path)) {
      log.body = sanitizeBody(req.path, req.body);
    }

    console.log(JSON.stringify(log));
  });

  next();
});

/**
 * Auth:
 * - /health: sem auth
 * - /budget/webhook: valida por X-Webhook-Token (não Bearer)
 * - demais: Bearer API_KEY
 */
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (req.path === "/budget/webhook") return next();

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token || token !== APP.apiKey) {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
  next();
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: "sap-bridge", ts: new Date().toISOString() });
});

/**
 * Customer lookup (CNPJ -> CardCode)
 * Mantém conversationId vindo do Octadesk
 */
app.post("/customer/lookup", async (req, res) => {
  try {
    const cnpj = req.body?.cnpj;
    const conversationId = req.body?.conversationId;

    const digits = normalizeCNPJNumeric(cnpj);
    if (digits.length !== 14) {
      return res.status(400).json({ ok: false, error: "INVALID_CNPJ" });
    }

    const cardCode = await getCardCodeByCNPJ_HANA(digits);

    if (!cardCode) {
      return res.status(404).json({
        ok: true,
        exists: false,
        conversationId: conversationId || null,
      });
    }

    return res.status(200).json({
      ok: true,
      exists: true,
      cardCode,
      conversationId: conversationId || null,
    });
  } catch (err) {
    console.error("lookup error:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

/**
 * NEW: Search tires by (aro + medida)
 * Returns only: ItemCode + U_SX_Marca
 */
app.post("/products/search-tires", async (req, res) => {
  try {
    const { aro, medida } = req.body || {};

    if (!aro || !medida) {
      return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    }

    const rows = await searchTiresByAroMedida_HANA(aro, medida);

    return res.status(200).json({
      ok: true,
      items: (rows || []).map((r) => ({
        itemCode: r.ItemCode,
        marca: r.U_SX_Marca,
        nome: r.ItemName,
      })),
    });
  } catch (err) {
    console.error("search tires error:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

/**
 * POST /budget/start
 * - Agora envia somente (cardCode + itemCode) para a API externa
 *
 * .env necessários:
 *   EXTERNAL_BUDGET_URL=https://...
 *   EXTERNAL_BUDGET_TOKEN=... (opcional)
 *   PUBLIC_BASE_URL=https://seu-dominio.com (opcional; se não tiver, usa Host header)
 */
app.post("/budget/start", async (req, res) => {
  try {
    const { cardCode, itemCode, clientRef, conversationId } = req.body || {};

    if (!cardCode || !itemCode) {
      return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    }

    const url = process.env.EXTERNAL_BUDGET_URL;
    if (!url) {
      return res.status(500).json({ ok: false, error: "MISSING_EXTERNAL_BUDGET_URL" });
    }

    const base =
      process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") ||
      `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;

    // payload para a API externa (novo contrato)
    const payload = {
      cardCode,
      itemCode,
      clientRef: clientRef || conversationId || null,
      callbackUrl: `${base}/budget/webhook`,
    };

    const headers = { "Content-Type": "application/json" };
    if (process.env.EXTERNAL_BUDGET_TOKEN) {
      headers["Authorization"] = `Bearer ${process.env.EXTERNAL_BUDGET_TOKEN}`;
    }

    const resp = await axios.post(url, payload, {
      headers,
      timeout: 15000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      return res.status(502).json({
        ok: false,
        error: "EXTERNAL_API_ERROR",
        status: resp.status,
      });
    }

    const transitionId = resp.data?.transitionId || resp.data?.id || resp.data?.transactionId || null;
    if (!transitionId) {
      return res.status(502).json({ ok: false, error: "MISSING_TRANSITION_ID" });
    }

    return res.status(200).json({ ok: true, transitionId, status: "PROCESSING" });
  } catch (err) {
    console.error("budget start error:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

/**
 * POST /budget/webhook
 * - API externa chama aqui com transitionId + dados da cotação
 * - valida X-Webhook-Token
 *
 * .env necessário:
 *   WEBHOOK_TOKEN=segredo
 */
app.post("/budget/webhook", async (req, res) => {
  try {
    const token = req.headers["x-webhook-token"];
    if (!token || token !== process.env.WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED_WEBHOOK" });
    }

    const { transitionId, status, result } = req.body || {};
    if (!transitionId) {
      return res.status(400).json({ ok: false, error: "MISSING_TRANSITION_ID" });
    }

    console.log("[budget-webhook] received", { transitionId, status });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("budget webhook error:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

app.listen(APP.port, "127.0.0.1", () => {
  console.log(`[sap-bridge] listening on 127.0.0.1:${APP.port}`);
});