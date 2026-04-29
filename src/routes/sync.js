const express = require('express');
const router = express.Router();

// ── FluentCRM API Client ──
class FluentCrmClient {
  constructor(baseUrl, user, pass) {
    this.baseUrl = baseUrl;
    this.authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }

  async fetch(endpoint, params = {}) {
    const url = new URL(`${this.baseUrl}/wp-json/fluent-crm/v2/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });

    const response = await globalThis.fetch(url.toString(), {
      headers: {
        'Authorization': this.authHeader,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`FluentCRM API ${response.status}: ${body.substring(0, 200)}`);
    }

    return response.json();
  }

  async getSubscribers(page = 1, perPage = 100) {
    return this.fetch('subscribers', {
      per_page: perPage,
      page,
      sort_by: 'id',
      sort_order: 'ASC',
    });
  }
}

// ── Extract tag/list names ──
function extractNames(items) {
  if (!items || !Array.isArray(items)) return [];
  return items.map(item => item.title || item.name || item.label || '').filter(Boolean);
}

// ── Sync Logic ──
async function syncContacts(prisma) {
  const startTime = Date.now();
  const stats = { created: 0, updated: 0, unchanged: 0, errors: 0, total: 0 };

  const fluentcrmUrl = process.env.FLUENTCRM_URL?.replace(/\/$/, '');
  const apiUser = process.env.FLUENTCRM_API_USER;
  const apiPass = process.env.FLUENTCRM_API_PASS;

  if (!fluentcrmUrl || !apiUser || !apiPass) {
    throw new Error('FluentCRM nicht konfiguriert (FLUENTCRM_URL, FLUENTCRM_API_USER, FLUENTCRM_API_PASS)');
  }

  const client = new FluentCrmClient(fluentcrmUrl, apiUser, apiPass);

  // Fetch all pages
  let page = 1;
  let lastPage = 1;
  let allSubscribers = [];

  do {
    const response = await client.getSubscribers(page, 100);
    const subscribers = response.data || response.subscribers?.data || [];
    lastPage = response.last_page || response.subscribers?.last_page || 1;
    allSubscribers = allSubscribers.concat(subscribers);
    page++;
  } while (page <= lastPage);

  stats.total = allSubscribers.length;

  // Process each subscriber
  for (const sub of allSubscribers) {
    try {
      const fluentcrmId = parseInt(sub.id);
      if (!fluentcrmId) continue;

      const data = {
        fluentcrmId,
        firstName: (sub.first_name || '').trim() || 'Unbekannt',
        lastName: (sub.last_name || '').trim() || 'Unbekannt',
        email: sub.email || null,
        phone: sub.phone || null,
        street: sub.address_line_1 || null,
        city: sub.city || null,
        zip: sub.postal_code || null,
        country: sub.country || 'DE',
        company: sub.company_id ? (sub.company?.name || null) : null,
        tags: extractNames(sub.tags),
        lists: extractNames(sub.lists),
        customFields: sub.custom_fields || null,
        source: 'FLUENTCRM',
        lastSyncAt: new Date(),
      };

      const existing = await prisma.customer.findUnique({
        where: { fluentcrmId },
      });

      if (!existing) {
        await prisma.customer.create({ data });
        stats.created++;
      } else {
        const changed =
          existing.firstName !== data.firstName ||
          existing.lastName !== data.lastName ||
          existing.email !== data.email ||
          existing.phone !== data.phone;

        if (changed) {
          await prisma.customer.update({ where: { fluentcrmId }, data });
          stats.updated++;
        } else {
          await prisma.customer.update({
            where: { fluentcrmId },
            data: { lastSyncAt: data.lastSyncAt },
          });
          stats.unchanged++;
        }
      }
    } catch (err) {
      stats.errors++;
    }
  }

  // Log result
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  await prisma.syncLog.create({
    data: {
      type: 'fluentcrm',
      status: stats.errors > 0 ? 'partial' : 'success',
      recordCount: stats.total,
      details: JSON.stringify({ ...stats, durationSeconds: parseFloat(duration) }),
    },
  });

  return { ...stats, duration };
}

// ── API Endpoints ──

// POST /api/sync/fluentcrm - Manuellen Sync starten
router.post('/fluentcrm', async (req, res) => {
  try {
    console.log('🔄 Manueller FluentCRM Sync gestartet...');
    const result = await syncContacts(req.prisma);
    console.log(`✅ Sync fertig: ${result.created} neu, ${result.updated} aktualisiert, ${result.unchanged} unverändert`);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ Sync Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/status - Letzten Sync-Status abrufen
router.get('/status', async (req, res) => {
  try {
    const lastSync = await req.prisma.syncLog.findFirst({
      where: { type: 'fluentcrm' },
      orderBy: { createdAt: 'desc' },
    });
    res.json(lastSync || { status: 'never', message: 'Noch kein Sync durchgeführt' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/test - FluentCRM Verbindung testen
router.get('/test', async (req, res) => {
  try {
    const fluentcrmUrl = process.env.FLUENTCRM_URL?.replace(/\/$/, '');
    const apiUser = process.env.FLUENTCRM_API_USER;
    const apiPass = process.env.FLUENTCRM_API_PASS;

    if (!fluentcrmUrl || !apiUser || !apiPass) {
      return res.json({ connected: false, error: 'FluentCRM nicht konfiguriert' });
    }

    const client = new FluentCrmClient(fluentcrmUrl, apiUser, apiPass);
    const response = await client.getSubscribers(1, 1);
    const total = response.total || response.subscribers?.total || 0;

    res.json({ connected: true, totalContacts: total, url: fluentcrmUrl });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// ── Auto-Sync Cron (alle 6h) ──
let cronStarted = false;
function startCron(prisma) {
  if (cronStarted) return;
  cronStarted = true;

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      console.log(`⏰ Auto-Sync FluentCRM (${new Date().toLocaleString('de-DE')})`);
      await syncContacts(prisma);
    } catch (err) {
      console.error('❌ Auto-Sync Fehler:', err.message);
    }
  }, SIX_HOURS);

  console.log('📅 FluentCRM Auto-Sync: alle 6 Stunden');
}

module.exports = router;
module.exports.startCron = startCron;
