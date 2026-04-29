const express = require('express');
const { authenticate } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate);

// Firmenadresse Schreinerhelden
const FIRMA_ADRESSE = 'Lindenstraße 9-15, 71540 Murrhardt-Fornsbach';

/**
 * GET /api/distance/:customerId
 * Berechnet Entfernung + Fahrzeit von Firma zum Kunden
 * Nutzt OpenStreetMap Nominatim (geocoding) + OSRM (routing) - komplett kostenlos!
 */
router.get('/:customerId', async (req, res) => {
  try {
    const customer = await req.prisma.customer.findUnique({
      where: { id: req.params.customerId },
      select: { firstName: true, lastName: true, street: true, zip: true, city: true }
    });

    if (!customer) return res.status(404).json({ error: 'Kunde nicht gefunden' });

    const kundeAdresse = [customer.street, customer.zip, customer.city].filter(Boolean).join(', ');
    if (!kundeAdresse || kundeAdresse.length < 5) {
      return res.json({ error: 'Keine vollständige Adresse beim Kunden hinterlegt', distance: null });
    }

    // Geocode both addresses using Nominatim (free, no API key needed)
    const [firmaCoords, kundeCoords] = await Promise.all([
      geocode(FIRMA_ADRESSE),
      geocode(kundeAdresse)
    ]);

    if (!firmaCoords || !kundeCoords) {
      return res.json({ error: 'Adresse konnte nicht gefunden werden', distance: null });
    }

    // Calculate route using OSRM (free, no API key needed)
    const route = await calculateRoute(firmaCoords, kundeCoords);

    if (!route) {
      return res.json({ error: 'Route konnte nicht berechnet werden', distance: null });
    }

    // Update customer's km in all active projects if not set
    const result = {
      von: FIRMA_ADRESSE,
      nach: kundeAdresse,
      kunde: `${customer.firstName} ${customer.lastName}`,
      distanzKm: Math.round(route.distance / 1000 * 10) / 10,
      fahrzeitMin: Math.round(route.duration / 60),
      fahrzeitText: formatDuration(route.duration),
      firmaCoords,
      kundeCoords,
    };

    res.json(result);
  } catch (err) {
    console.error('[DISTANCE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/distance/coords/:lat/:lng
 * Returns route from firma to specific coordinates
 */
router.get('/coords/:lat/:lng', async (req, res) => {
  try {
    const firmaCoords = await geocode(FIRMA_ADRESSE);
    const kundeCoords = { lat: parseFloat(req.params.lat), lon: parseFloat(req.params.lng) };

    const route = await calculateRoute(firmaCoords, kundeCoords);
    if (!route) return res.json({ error: 'Route nicht berechenbar' });

    res.json({
      distanzKm: Math.round(route.distance / 1000 * 10) / 10,
      fahrzeitMin: Math.round(route.duration / 60),
      fahrzeitText: formatDuration(route.duration),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Geocoding via Nominatim (OpenStreetMap) ──
async function geocode(address) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=de`;
    const response = await globalThis.fetch(url, {
      headers: { 'User-Agent': 'MEOS4-Schreinerhelden/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json();
    if (data.length === 0) return null;
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  } catch (err) {
    console.error('[GEOCODE]', err.message);
    return null;
  }
}

// ── Routing via OSRM (OpenStreetMap) ──
async function calculateRoute(from, to) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
    const response = await globalThis.fetch(url, {
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json();
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error('OSRM no route');
    return {
      distance: data.routes[0].distance, // meters
      duration: data.routes[0].duration   // seconds
    };
  } catch (err) {
    console.log('[ROUTE] OSRM fehlgeschlagen, nutze Haversine-Fallback:', err.message);
    // Fallback: Luftlinie × 1.35 (typischer Straßen-Umwegfaktor)
    const dist = haversineDistance(from.lat, from.lon, to.lat, to.lon);
    const roadDist = dist * 1.35;
    const duration = (roadDist / 1000) / 70 * 3600; // ~70 km/h Durchschnitt
    return { distance: roadDist, duration };
  }
}

// Haversine-Formel: Luftlinie in Metern
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h} Std ${m} Min`;
  return `${m} Min`;
}

module.exports = router;
