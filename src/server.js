import express from 'express';
import { APP } from '../config/env.js';
import { getCardCodeByCNPJ_HANA } from '../db/hana.js';
import { normalizeCNPJNumeric } from '../utils/cnpj.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Auth simples por API Key (bom pro MVP; depois dá pra evoluir pra HMAC)
app.use((req, res, next) => {
  // health sem auth
  if (req.path === '/health') return next();

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || token !== APP.apiKey) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, service: 'sap-bridge', ts: new Date().toISOString() });
});

app.post('/customer/lookup', async (req, res) => {
  try {
    const cnpj = req.body?.cnpj;
    const digits = normalizeCNPJNumeric(cnpj);

    if (digits.length !== 14) {
      return res.status(400).json({ ok: false, error: 'INVALID_CNPJ' });
    }

    const cardCode = await getCardCodeByCNPJ_HANA(digits);

    if (!cardCode) {
      return res.status(404).json({ ok: true, exists: false });
    }

    return res.status(200).json({ ok: true, exists: true, cardCode });
  } catch (err) {
    console.error('lookup error:', err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

app.listen(APP.port, () => {
  console.log(`[sap-bridge] listening on port ${APP.port}`);
});