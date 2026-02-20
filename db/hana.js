import hanaClient from '@sap/hana-client';
import { HANA } from '../config/env.js';
import { normalizeCNPJNumeric, formatCNPJMask } from '../utils/cnpj.js';

function connParams() {
  const p = {
    serverNode: `${HANA.server}:${HANA.port}`,
    uid: HANA.uid,
    pwd: HANA.pwd,
  };
  if (HANA.schema) p.CURRENTSCHEMA = HANA.schema;
  return p;
}

async function queryOne(sql, params = []) {
  const conn = hanaClient.createConnection();
  await new Promise((res, rej) => conn.connect(connParams(), (e) => (e ? rej(e) : res())));
  try {
    const stmt = conn.prepare(sql);
    const rows = await new Promise((res, rej) => stmt.exec(params, (e, rs) => (e ? rej(e) : res(rs))));
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } finally {
    try { conn.disconnect(); } catch {}
  }
}

export async function getCardCodeByCNPJ_HANA(cnpjInput) {
  const digits = normalizeCNPJNumeric(cnpjInput || '');
  if (digits.length !== 14) return null;

  const formatted = formatCNPJMask(digits);
  if (!formatted) return null;

  // 1) tenta exatamente como está gravado (muitas bases guardam com máscara)
  const rowExact = await queryOne(
    `
    SELECT T0."CardCode"
    FROM CRD7 T0
    JOIN OCRD T1 ON T1."CardCode" = T0."CardCode"
    WHERE T0."TaxId0" = ?
    LIMIT 1
  `,
    [formatted]
  );

  if (rowExact?.CardCode) return rowExact.CardCode;

  // 2) tenta comparar só dígitos (caso esteja sem máscara no banco)
  const rowDigits = await queryOne(
    `
    SELECT T0."CardCode"
    FROM CRD7 T0
    JOIN OCRD T1 ON T1."CardCode" = T0."CardCode"
    WHERE REPLACE(REPLACE(REPLACE(T0."TaxId0",'.',''),'/',''),'-','') = ?
    LIMIT 1
  `,
    [digits]
  );

  return rowDigits?.CardCode || null;
}