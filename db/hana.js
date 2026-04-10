import hanaClient from '@sap/hana-client';
import { HANA } from '../config/env.js';
import { normalizeCNPJNumeric, formatCNPJMask } from '../utils/cnpj.js';
import { buildPhoneLookupCandidates } from '../utils/phone.js';
import { parseTireSearch } from '../utils/tire-search.js';

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

async function queryAll(sql, params = []) {
  const conn = hanaClient.createConnection();
  await new Promise((res, rej) => conn.connect(connParams(), (e) => (e ? rej(e) : res())));
  try {
    const stmt = conn.prepare(sql);
    const rows = await new Promise((res, rej) => stmt.exec(params, (e, rs) => (e ? rej(e) : res(rs))));
    return Array.isArray(rows) ? rows : [];
  } finally {
    try { conn.disconnect(); } catch {}
  }
}

function normalizedPhoneSql(columnRef) {
  return `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(${columnRef}, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '/', ''), '.', '')`;
}

export async function getCardCodeByCNPJ_HANA(cnpjInput) {
  const digits = normalizeCNPJNumeric(cnpjInput || '');
  if (digits.length !== 14) return null;

  const formatted = formatCNPJMask(digits);
  if (!formatted) return null;

  // 1) tenta exatamente como está gravado (muitas bases guardam com máscara)
  const rowExact = await queryOne(
    `
    SELECT T0."CardCode", T2."Mobil"
    FROM CRD7 T0
    JOIN OCRD T1 ON T1."CardCode" = T0."CardCode"
    LEFT JOIN OSLP T2 ON T2."SlpCode" = T1."SlpCode"
    WHERE T0."TaxId0" = ?
    LIMIT 1
  `,
    [formatted]
  );

  if (rowExact?.CardCode) return { cardCode: rowExact.CardCode, mobil: rowExact.Mobil || null };

  // 2) tenta comparar só dígitos (caso esteja sem máscara no banco)
  const rowDigits = await queryOne(
    `
    SELECT T0."CardCode", T2."Mobil"
    FROM CRD7 T0
    JOIN OCRD T1 ON T1."CardCode" = T0."CardCode"
    LEFT JOIN OSLP T2 ON T2."SlpCode" = T1."SlpCode"
    WHERE REPLACE(REPLACE(REPLACE(T0."TaxId0",'.',''),'/',''),'-','') = ?
    LIMIT 1
  `,
    [digits]
  );

  if (rowDigits?.CardCode) return { cardCode: rowDigits.CardCode, mobil: rowDigits.Mobil || null };
  return null;
}

export async function getContactsByPhone_HANA(phoneInput) {
  const candidates = buildPhoneLookupCandidates(phoneInput);
  if (!candidates.length) return [];

  const tel1Sql = normalizedPhoneSql('T0."Tel1"');
  const tel2Sql = normalizedPhoneSql('T0."Tel2"');
  const cellolarSql = normalizedPhoneSql('T0."Cellolar"');
  const inPlaceholders = candidates.map(() => '?').join(', ');

  const sql = `
    SELECT
      T0."CntctCode",
      T0."Name",
      T0."CardCode",
      T1."CardName",
      T2."Mobil",
      T0."Position",
      T0."Tel1",
      T0."Tel2",
      T0."Cellolar",
      CASE
        WHEN ${cellolarSql} IN (${inPlaceholders}) THEN 'Cellolar'
        WHEN ${tel1Sql} IN (${inPlaceholders}) THEN 'Tel1'
        WHEN ${tel2Sql} IN (${inPlaceholders}) THEN 'Tel2'
        ELSE NULL
      END AS "MatchedField"
    FROM OCPR T0
    LEFT JOIN OCRD T1 ON T1."CardCode" = T0."CardCode"
    LEFT JOIN OSLP T2 ON T2."SlpCode" = T1."SlpCode"
    WHERE
      ${cellolarSql} IN (${inPlaceholders})
      OR ${tel1Sql} IN (${inPlaceholders})
      OR ${tel2Sql} IN (${inPlaceholders})
    ORDER BY
      T0."CardCode",
      T0."Name"
    LIMIT 20
  `;

  const params = [
    ...candidates,
    ...candidates,
    ...candidates,
    ...candidates,
    ...candidates,
    ...candidates,
  ];
  const rows = await queryAll(sql, params);

  return rows.map((row) => ({
    cntctCode: row.CntctCode,
    name: row.Name,
    cardCode: row.CardCode,
    cardName: row.CardName || null,
    mobil: row.Mobil || null,
    position: row.Position || null,
    matchedField: row.MatchedField || null,
    phones: {
      tel1: row.Tel1 || null,
      tel2: row.Tel2 || null,
      cellolar: row.Cellolar || null,
    },
  }));
}

export async function searchTiresByAroMedida_HANA(searchInput, cardCodeInput = "") {
  const parsedSearch = typeof searchInput === "string" ? parseTireSearch(searchInput) : searchInput;
  if (!parsedSearch?.aro || !Array.isArray(parsedSearch.searchPatterns) || parsedSearch.searchPatterns.length === 0) {
    return [];
  }

  const aro = String(parsedSearch.aro).replace(/\D/g, "");
  if (!aro) return [];

  const cardCode = String(cardCodeInput || "").trim();
  const aroPattern = `${aro}" %`;
  const normalizedPatterns = [...new Set(parsedSearch.searchPatterns.map((pattern) => `%${pattern}%`))];
  const normalizedItemNameSql = `
        UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(T0."ItemName", ''), ' ', ''), '/', ''), '"', ''), '.', ''), ',', ''), '-', ''))
  `;
  const normalizedPatternClause = normalizedPatterns
    .map(() => `${normalizedItemNameSql} LIKE ?`)
    .join("\n        OR ");

  const sql = `
    SELECT
        T0."ItemCode",
        T0."U_SX_Marca",
        T0."ItemName",
        SUM(IFNULL(T1."OnHand", 0) - IFNULL(T1."IsCommited", 0)) AS "Estoque Total"
    FROM OITM T0
    INNER JOIN OITW T1
        ON T1."ItemCode" = T0."ItemCode"
    WHERE
        T0."ItemName" LIKE ?
        AND (
        ${normalizedPatternClause}
        )
        AND IFNULL(T0."U_SX_Marca", '') <> ''
        AND T0."SellItem" = 'Y'
        AND T0."MatType" = 0
        AND T0."ItmsGrpCod" IN (
            146, 145, 103, 104, 105, 106, 107, 144,
            108, 109, 110, 111, 112, 149, 113, 114,
            115, 116, 117, 118, 119, 120, 121, 122
        )
        AND T1."WhsCode" IN (
            'AWSBA001',
            'AWSCE001',
            'AWSDF001',
            'AWSES001',
            'AWSGO001',
            'AWSMG001',
            'AWSMS001',
            'AWSMT001',
            'AWSPCA01',
            'AWSPE001',
            'AWSPR001',
            'AWSRJ010',
            'AWSRS001',
            'AWSSC001',
            'AWSSJRP1',
            'AWSSP001',
            'AWSUB001',
            'IMP-001'
        )
          AND NOT (
              UPPER(IFNULL(T0."U_SX_Marca", '')) = 'CONTINENTAL'
              AND EXISTS (
                  SELECT 1
                  FROM OCRD C
                  WHERE C."CardCode" = ?
                    AND IFNULL(C."State2", '') NOT IN ('PR', 'MT')
              )
          )
    GROUP BY
        T0."ItemCode",
        T0."U_SX_Marca",
        T0."ItemName"
    HAVING
        SUM(IFNULL(T1."OnHand", 0) - IFNULL(T1."IsCommited", 0)) > 4
    ORDER BY
        T0."U_SX_Marca",
        T0."ItemCode"
    LIMIT 100
  `;

  const rows = await queryAll(sql, [aroPattern, ...normalizedPatterns, cardCode]);
  return rows || [];
}

export async function getTireByItemCode_HANA(itemCode) {
  const code = String(itemCode || "").trim();
  if (!code) return null;

  const sql = `
    SELECT
      T0."ItemCode",
      T0."U_SX_Marca",
      T0."ItemName"
    FROM OITM T0
    WHERE T0."ItemCode" = ?
    LIMIT 1
  `;

  const row = await queryOne(sql, [code]);
  return row || null;
}

export async function getProductInfoFromProc_HANA(itemCode) {
  const code = String(itemCode || "").trim();
  if (!code) return null;

  const sql = `CALL "SBO_GPIMPORTS"."spcGPConsultaPrecoSKU"(?)`;

  const rows = await queryAll(sql, [code]);
  return rows && rows.length ? rows[0] : null;
}
