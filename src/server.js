// src/server.js
import express from "express";
import crypto from "crypto";
import axios from "axios";

import { APP } from "../config/env.js";
import { getCardCodeByCNPJ_HANA, searchTiresByAroMedida_HANA, getTireByItemCode_HANA,getProductInfoFromProc_HANA} from "../db/hana.js";
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
 * Search tires by (medida + aro)
 * Busca itens no HANA e preço via API externa (priceaftax)
 */
app.post("/products/search-tires", async (req, res) => {
  try {
    const { medida: medidaRaw, cnpj } = req.body || {};

    if (!medidaRaw || !cnpj) {
      return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    }

    // Normaliza: remove caracteres especiais, troca por espaço e colapsa extras
    // Aceita "305/25 R32", "305 25 R32", "305/25R32" -> aro="32", medida="305 25"
    const normalized = String(medidaRaw).replace(/[^0-9a-zA-Z]+/g, " ").replace(/\s+/g, " ").trim();
    const parts = normalized.split(" ");

    if (parts.length < 2) {
      return res.status(400).json({ ok: false, error: "INVALID_FORMAT" });
    }

    // Aro é o último token (extrai só os dígitos, ex: "R32" -> "32")
    const aro = parts[parts.length - 1].replace(/\D/g, "");
    const medida = parts.slice(0, -1).join(" ");

    if (!aro || !medida) {
      return res.status(400).json({ ok: false, error: "INVALID_FORMAT" });
    }

    // 1) Busca itens no HANA
    const rows = await searchTiresByAroMedida_HANA(aro, medida);

    if (!rows || rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NO_PRODUCTS_FOUND" });
    }

    // 2) Chama API externa para obter preços (priceaftax)
    const baseUrl = process.env.EXTERNAL_BASE_URL;
    const token = process.env.EXTERNAL_TOKEN;

    if (!baseUrl || !token) {
      return res.status(500).json({ ok: false, error: "MISSING_EXTERNAL_CONFIG" });
    }

    const externalUrl = `${baseUrl.replace(/\/+$/, "")}/crmb1/server/api/Order/PostNewQuotationByCNPJ`;
    const externalBody = rows.map((r) => ({ itemcode: r.ItemCode, quantity: 1 }));

    let priceMap = {};
    try {
      const externalResp = await axios.post(externalUrl, externalBody, {
        params: { token, cnpj },
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
        validateStatus: () => true,
      });

      if (externalResp.status >= 200 && externalResp.status < 300 && Array.isArray(externalResp.data?.items)) {
        for (const item of externalResp.data.items) {
          if (item.itemcode && item.priceaftax != null) {
            priceMap[item.itemcode] = item.priceaftax;
          }
        }
      }
    } catch (e) {
      console.error("external price api error:", e);
      // continua sem preço se a API externa falhar
    }

    // 3) Monta retorno cruzando preços — filtra itens com preco 0 ou sem preço
    const items = rows
      .map((r) => {
        const preco = priceMap[r.ItemCode] != null ? parseFloat(priceMap[r.ItemCode]) : null;
        const precoFormatado = preco !== null && !isNaN(preco)
          ? preco.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : null;
        return {
          itemCode: r.ItemCode,
          marca: r.U_SX_Marca,
          nome: r.ItemName,
          valorUnitario: precoFormatado,
          _preco: preco,
        };
      })
      .filter((r) => r._preco !== null && r._preco > 0)
      .map(({ _preco, ...r }) => r);

    if (items.length === 0) {
      return res.status(404).json({ ok: false, error: "NO_PRODUCTS_FOUND" });
    }

    const mensagem = `Temos as seguintes opções de pneus para o aro ${aro} e medida ${medida} informados:\n${
      items.map((r) => {
        const nomeSimples = r.nome.replace(/^.*?Z?R\d+\s+/i, "").trim();
        return `${r.marca} - ${nomeSimples}\nPreço Unitário: R$ ${r.valorUnitario}\n`;
      }).join("\n")
    }`;

    return res.status(200).json({ ok: true, items, mensagem });
  } catch (err) {
    console.error("search tires error:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

app.get("/products/item/:itemCode", async (req, res) => {
  try {
    const itemCode = req.params?.itemCode;
    if (!itemCode || String(itemCode).trim().length === 0) {
      return res.status(400).json({ ok: false, error: "MISSING_ITEMCODE" });
    }

    const row = await getProductInfoFromProc_HANA(itemCode);

    if (!row) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    // Por enquanto devolvo "data" com tudo que a procedure retornar.
    // Depois, se você me mandar as colunas, eu mapeio pra um JSON mais limpo.
    const formatted = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k,
        typeof v === "number" ? parseFloat(v.toFixed(2)) : v,
      ])
    );

    return res.status(200).json({
      ok: true,
      itemCode: String(itemCode),
      data: formatted,
    });
  } catch (err) {
    console.error("product proc error:", err);
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
    const cnpj = req.body?.cnpj;
    const itemCode = req.body?.itemCode;
    const quantityRaw = req.body?.quantity;

    const digits = normalizeCNPJNumeric(cnpj);
    if (digits.length !== 14) {
      return res.status(400).json({ ok: false, error: "INVALID_CNPJ" });
    }

    if (!itemCode || String(itemCode).trim().length === 0) {
      return res.status(400).json({ ok: false, error: "MISSING_ITEMCODE" });
    }

    const quantity = Number(quantityRaw ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ ok: false, error: "INVALID_QUANTITY" });
    }

    const baseUrl = process.env.EXTERNAL_BASE_URL;
    const token = process.env.EXTERNAL_TOKEN;

    if (!baseUrl) {
      return res.status(500).json({ ok: false, error: "MISSING_EXTERNAL_BASE_URL" });
    }
    if (!token) {
      return res.status(500).json({ ok: false, error: "MISSING_EXTERNAL_TOKEN" });
    }

    const url = `${baseUrl.replace(/\/+$/, "")}/crmb1/server/api/Order/PostNewQuotationByCNPJ`;

    // API externa exige SEMPRE um array, mesmo com 1 item
    const body = [
      {
        itemcode: String(itemCode).trim(),
        quantity,
      },
    ];

    const resp = await axios.post(url, body, {
      params: { token, cnpj }, // precisa ir completo
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      return res.status(502).json({
        ok: false,
        error: "EXTERNAL_API_ERROR",
        status: resp.status,
        message: typeof resp.data === "string" ? resp.data.slice(0, 200) : undefined,
      });
    }

    // Formato esperado: {"status":"Integrado","error":"","id":699637}
    const externalStatusText = resp.data?.status ?? null;
    const externalErrorText = resp.data?.error ?? null;
    const transitionId = resp.data?.id ?? null;

    if (!transitionId) {
      return res.status(502).json({
        ok: false,
        error: "MISSING_TRANSITION_ID",
        externalStatus: externalStatusText,
        externalError: externalErrorText,
      });
    }

    // Opcional: se a API externa retornar status != Integrado mas ainda com id, você decide o que fazer
    // Aqui vamos aceitar e deixar o fluxo seguir.
    return res.status(200).json({
      ok: true,
      transitionId,
      status: "PROCESSING",
      external: {
        status: externalStatusText,
        error: externalErrorText,
      },
    });
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

    const { transitionId, status, ...result } = req.body || {};
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