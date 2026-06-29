const axios  = require('axios');
const crypto = require('crypto');

// ── Dice ──────────────────────────────────────────────
const DICE_URL      = 'https://dev.use-dice.com';
const CLIENT_ID     = process.env.DICE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.DICE_CLIENT_SECRET || '';
const WEBHOOK_URL   = process.env.WEBHOOK_URL         || '';

// ── Facebook CAPI ─────────────────────────────────────
const FB_PIXEL_ID   = '1350679366463627';
const FB_CAPI_TOKEN = process.env.FB_CAPI_TOKEN || '';

let _token  = null;
let _expiry = 0;

async function getDiceToken() {
  if (_token && Date.now() < _expiry) return _token;
  const res = await axios.post(`${DICE_URL}/api/v1/auth/login`, {
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET
  });
  _token  = res.data.token || res.data.access_token;
  _expiry = Date.now() + 50 * 60 * 1000;
  return _token;
}

function sha256(str) {
  return crypto.createHash('sha256').update(String(str).trim().toLowerCase()).digest('hex');
}

async function sendCapiPurchase(req, body, customData) {
  if (!FB_CAPI_TOKEN) return;

  const {
    nome, email, tel,
    fb_event_id, fb_fbc, fb_fbp,
    fb_event_source_url, fb_user_agent
  } = body;

  const nameParts = (nome || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ') || '';

  // Formata telefone para E.164 Brasil (55 + DDD + número)
  const digits = (tel || '').replace(/\D/g, '');
  const phone  = digits.length >= 10 ? '55' + digits : digits;

  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
                 || req.headers['x-real-ip']
                 || '';

  const userData = {
    client_ip_address: clientIp,
    client_user_agent: fb_user_agent || req.headers['user-agent'] || ''
  };
  if (email)     userData.em  = [sha256(email)];
  if (firstName) userData.fn  = [sha256(firstName)];
  if (lastName)  userData.ln  = [sha256(lastName)];
  if (phone)     userData.ph  = [sha256(phone)];
  if (fb_fbc)    userData.fbc = fb_fbc;
  if (fb_fbp)    userData.fbp = fb_fbp;

  const payload = {
    data: [{
      event_name:       'Purchase',
      event_time:       Math.floor(Date.now() / 1000),
      event_id:         fb_event_id || '',
      action_source:    'website',
      event_source_url: fb_event_source_url || 'https://peido-de-alemao.vercel.app',
      user_data:        userData,
      custom_data:      customData
    }],
    access_token: FB_CAPI_TOKEN
  };

  await axios.post(
    `https://graph.facebook.com/v19.0/${FB_PIXEL_ID}/events`,
    payload
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, erro: 'Method not allowed' });
  }

  try {
    const {
      nome, email, cpf, tel,
      kit_label, kit_id, kit_qtd, total
    } = req.body;

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

    // Envia CAPI Purchase (fire-and-forget — não bloqueia a resposta)
    sendCapiPurchase(req, req.body, {
      value:        parseFloat(total.toFixed(2)),
      currency:     'BRL',
      content_ids:  ['peido-alemao-kit-' + (kit_id || '')],
      content_name: `Peido Alemão — ${kit_label}`,
      content_type: 'product',
      num_items:    kit_qtd || 1
    }).catch(function(e) { console.error('[CAPI] erro:', e.message); });

    return res.json({
      ok:           true,
      qr_code_text: data.qr_code_text,
      payment_id:   data.id || data.payment_id || null,
      expires_at:   data.expires_at || null
    });

  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    console.error('[DICE] Erro:', msg);
    if (err.response?.status === 401) { _token = null; _expiry = 0; }
    return res.status(500).json({ ok: false, erro: msg || 'Erro interno ao criar pagamento.' });
  }
};
