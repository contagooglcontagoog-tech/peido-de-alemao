require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Serve a landing page (pasta pai)
app.use(express.static(path.join(__dirname, '..')));

// ─── Config ───────────────────────────────────────────
const DICE_URL       = 'https://dev.use-dice.com';
const CLIENT_ID      = process.env.DICE_CLIENT_ID     || '';
const CLIENT_SECRET  = process.env.DICE_CLIENT_SECRET || '';
const WEBHOOK_URL    = process.env.WEBHOOK_URL         || '';
const PORT           = process.env.PORT                || 3001;

// ─── Cache do token JWT ────────────────────────────────
let _token  = null;
let _expiry = 0;

async function getDiceToken() {
  if (_token && Date.now() < _expiry) return _token;

  const res = await axios.post(`${DICE_URL}/api/v1/auth/login`, {
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET
  });

  // a API pode retornar token ou access_token
  _token  = res.data.token || res.data.access_token;
  _expiry = Date.now() + 50 * 60 * 1000; // renova 10 min antes de 1h
  return _token;
}

// ─── POST /api/criar-pagamento ─────────────────────────
app.post('/api/criar-pagamento', async (req, res) => {
  try {
    const { nome, email, cpf, kit_label, total } = req.body;

    if (!nome || !email || !cpf || !total) {
      return res.status(400).json({ ok: false, erro: 'Campos obrigatórios faltando.' });
    }

    if (total < 2) {
      return res.status(400).json({ ok: false, erro: 'Valor mínimo é R$ 2,00.' });
    }

    const token   = await getDiceToken();
    const payload = {
      product_name: `Peido Alemão — ${kit_label}`,
      amount:       parseFloat(total.toFixed(2)),
      payer: {
        name:     nome,
        email:    email,
        document: cpf.replace(/\D/g, '')
      }
    };

    if (WEBHOOK_URL) payload.clientCallbackUrl = WEBHOOK_URL;

    const { data } = await axios.post(
      `${DICE_URL}/api/v2/payments/deposit`,
      payload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    return res.json({
      ok:           true,
      qr_code_text: data.qr_code_text,
      payment_id:   data.id || data.payment_id || null,
      expires_at:   data.expires_at || null
    });

  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    console.error('[DICE] Erro ao criar pagamento:', msg);

    // Se token expirou, limpa cache e o cliente pode tentar de novo
    if (err.response?.status === 401) { _token = null; _expiry = 0; }

    return res.status(500).json({ ok: false, erro: msg || 'Erro interno ao criar pagamento.' });
  }
});

// ─── POST /webhook/dice ────────────────────────────────
app.post('/webhook/dice', (req, res) => {
  const evento = req.body;
  console.log('[DICE WEBHOOK]', JSON.stringify(evento));

  // Status possíveis: PAID, EXPIRED, CANCELLED
  if (evento.status === 'PAID') {
    console.log(`✅ Pagamento confirmado — ID: ${evento.id || evento.payment_id}`);
    // TODO: marcar pedido como pago no seu banco de dados
  }

  res.sendStatus(200);
});

// ─── Start ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Peido Alemão server rodando em http://localhost:${PORT}`);
  if (!CLIENT_ID) console.warn('⚠️  DICE_CLIENT_ID não configurado — crie o arquivo .env');
});
