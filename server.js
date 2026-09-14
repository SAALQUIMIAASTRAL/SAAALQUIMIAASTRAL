require('dotenv').config();
const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase client (for public/admin operations)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Astrology API configuration
const ASTROLOGY_API_KEY = process.env.ASTROLOGY_API_KEY;
const ASTROLOGY_API_URL = 'https://api.astrology-api.io/api/v1';

// Helper: Verify JWT token and create authenticated Supabase client
function requireLogin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    // Create user-authenticated Supabase client for RLS
    req.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ============ AUTH ROUTES ============

// POST /auth/registro - Register new user
app.post('/auth/registro', async (req, res) => {
  const { email, password, nombre } = req.body;
  if (!email || !password || !nombre) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const { data, error } = await supabase.auth.signUpWithPassword({
      email,
      password
    });
    if (error) throw error;

    const token = jwt.sign(
      { id: data.user.id, email: data.user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Save user profile
    await supabase.from('usuarios').insert([
      { id: data.user.id, email, nombre }
    ]);

    res.json({ token, user: { id: data.user.id, email, nombre } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /auth/login - Login user
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    if (error) throw error;

    const token = jwt.sign(
      { id: data.user.id, email: data.user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ token, user: { id: data.user.id, email } });
  } catch (err) {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// ============ PROFILE ROUTES ============

// GET /perfil - Get user profile
app.get('/perfil', requireLogin, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('usuarios')
      .select('*')
      .eq('id', req.user.id)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /perfil - Save/update user profile
app.post('/perfil', requireLogin, async (req, res) => {
  const { nombre, fecha_nac, hora_nac, lugar_nac, lat, lon } = req.body;

  try {
    const { data, error } = await req.supabase
      .from('usuarios')
      .update({
        nombre,
        fecha_nac,
        hora_nac,
        lugar_nac,
        lat,
        lon,
        updated_at: new Date()
      })
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============ ASTROLOGICAL FEATURES ============

// POST /carta-natal - Calculate and save natal chart
app.post('/carta-natal', requireLogin, async (req, res) => {
  const { fecha, hora, lugar, lat, lon } = req.body;
  if (!fecha || !hora || !lugar || !lat || !lon) {
    return res.status(400).json({ error: 'Missing birth data' });
  }

  try {
    // Call Astrology API
    const response = await axios.post(
      `${ASTROLOGY_API_URL}/calculate/natal_chart`,
      {
        birth_date: fecha,
        birth_time: hora,
        latitude: lat,
        longitude: lon,
        timezone: 'America/Mexico_City' // Default timezone
      },
      {
        headers: { 'Authorization': `Bearer ${ASTROLOGY_API_KEY}` }
      }
    );

    const chartData = response.data;

    // Save to database
    const { data, error } = await req.supabase
      .from('cartas_natales')
      .insert([
        {
          usuario_id: req.user.id,
          fecha,
          hora,
          lugar,
          lat,
          lon,
          data: chartData,
          created_at: new Date()
        }
      ])
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /carta-natal/:id - Get saved natal chart
app.get('/carta-natal/:id', requireLogin, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('cartas_natales')
      .select('*')
      .eq('id', req.params.id)
      .eq('usuario_id', req.user.id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /carta-visual - Generate natal chart wheel SVG
app.post('/carta-visual', requireLogin, async (req, res) => {
  const { fecha, hora, lugar, lat, lon } = req.body;
  if (!fecha || !hora || !lugar || !lat || !lon) {
    return res.status(400).json({ error: 'Missing birth data' });
  }

  try {
    let chart = null;

    // Try to get natal chart data from Astrology API
    try {
      const response = await axios.post(
        `${ASTROLOGY_API_URL}/calculate/natal_chart`,
        {
          birth_date: fecha,
          birth_time: hora,
          latitude: lat,
          longitude: lon,
          timezone: 'America/Mexico_City'
        },
        {
          headers: { 'Authorization': `Bearer ${ASTROLOGY_API_KEY}` },
          timeout: 5000
        }
      );
      chart = response.data;
    } catch (apiErr) {
      console.log('API fallback triggered:', apiErr.message);
      // Use fallback demo chart data
      chart = generateDemoChart();
    }

    // Generate simple SVG wheel representation
    const svg = generateNatalChartSVG(chart);

    res.json({
      svg_content: svg,
      chart_data: chart
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /luna - Get current lunar phase
app.post('/luna', requireLogin, async (req, res) => {
  const { fecha } = req.body;
  const queryDate = fecha || new Date().toISOString().split('T')[0];

  try {
    let lunarData = null;

    try {
      const response = await axios.get(
        `${ASTROLOGY_API_URL}/calculate/lunar_phase`,
        {
          params: { date: queryDate },
          headers: { 'Authorization': `Bearer ${ASTROLOGY_API_KEY}` },
          timeout: 5000
        }
      );
      lunarData = response.data;
    } catch (apiErr) {
      // Fallback: demo lunar data
      lunarData = {
        phase: 'Creciente',
        illumination: 68,
        next_new_moon: '2026-09-24',
        first_quarter: '2026-09-17',
        full_moon: '2026-10-02',
        last_quarter: '2026-10-09'
      };
    }

    res.json({
      fase_actual: lunarData.phase,
      porcentaje: lunarData.illumination,
      fecha: queryDate,
      proximas_fases: {
        luna_nueva: lunarData.next_new_moon,
        cuarto_creciente: lunarData.first_quarter,
        luna_llena: lunarData.full_moon,
        cuarto_menguante: lunarData.last_quarter
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /transitos - Get current planetary transits
app.post('/transitos', requireLogin, async (req, res) => {
  const { fecha } = req.body;
  const queryDate = fecha || new Date().toISOString().split('T')[0];

  try {
    let transitsData = null;

    try {
      const response = await axios.post(
        `${ASTROLOGY_API_URL}/calculate/transits`,
        {
          date: queryDate,
          latitude: -99.1332, // Mexico City default
          longitude: 19.4343,
          timezone: 'America/Mexico_City'
        },
        {
          headers: { 'Authorization': `Bearer ${ASTROLOGY_API_KEY}` },
          timeout: 5000
        }
      );
      transitsData = response.data;
    } catch (apiErr) {
      // Fallback: demo transits data
      transitsData = {
        planets: {
          sun: { sign: 'Virgo', degree: 155 },
          moon: { sign: 'Géminis', degree: 65 },
          mercury: { sign: 'Virgo', degree: 158 },
          venus: { sign: 'Libra', degree: 180 },
          mars: { sign: 'Escorpio', degree: 210 }
        },
        aspects: [
          { planet1: 'Sun', planet2: 'Moon', aspect: 'Cuadratura', orb: 2.5 }
        ],
        moon: { sign: 'Géminis', degree: 65 },
        sun: { sign: 'Virgo', degree: 155 }
      };
    }

    res.json({
      fecha: queryDate,
      posiciones_planetarias: transitsData.planets,
      aspectos: transitsData.aspects,
      luna_posicion: transitsData.moon,
      sol_posicion: transitsData.sun
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /sinstria - Calculate synastry between two charts
app.post('/sinstria', requireLogin, async (req, res) => {
  const { carta1_id, carta2_id } = req.body;
  if (!carta1_id || !carta2_id) {
    return res.status(400).json({ error: 'Missing chart IDs' });
  }

  try {
    // Get both natal charts from database
    const { data: chart1 } = await req.supabase
      .from('cartas_natales')
      .select('data')
      .eq('id', carta1_id)
      .eq('usuario_id', req.user.id)
      .single();

    const { data: chart2 } = await req.supabase
      .from('cartas_natales')
      .select('data')
      .eq('id', carta2_id)
      .eq('usuario_id', req.user.id)
      .single();

    if (!chart1 || !chart2) {
      return res.status(404).json({ error: 'Charts not found' });
    }

    // Call Astrology API for synastry
    const response = await axios.post(
      `${ASTROLOGY_API_URL}/calculate/synastry`,
      {
        first_chart: chart1.data,
        second_chart: chart2.data
      },
      {
        headers: { 'Authorization': `Bearer ${ASTROLOGY_API_KEY}` }
      }
    );

    const synastryData = response.data;

    res.json({
      compatibilidad: synastryData.compatibility_score,
      aspectos_importantes: synastryData.important_aspects,
      venus_aspectos: synastryData.venus_aspects,
      marte_aspectos: synastryData.mars_aspects,
      luna_aspectos: synastryData.moon_aspects,
      interpretacion: synastryData.interpretation
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /tarot - Get daily tarot card
app.post('/tarot', requireLogin, async (req, res) => {
  const { tipo } = req.body; // 'diario', 'tirada_tres', 'cruz_celtica'
  const cardType = tipo || 'diario';

  try {
    let tarotData = null;

    try {
      const response = await axios.post(
        `${ASTROLOGY_API_URL}/calculate/tarot`,
        {
          spread_type: cardType,
          date: new Date().toISOString().split('T')[0]
        },
        {
          headers: { 'Authorization': `Bearer ${ASTROLOGY_API_KEY}` },
          timeout: 5000
        }
      );
      tarotData = response.data;
    } catch (apiErr) {
      // Fallback: demo tarot cards
      const demoCards = [
        { name: 'La Rueda de la Fortuna', meaning: 'Cambio de destino, ciclos' },
        { name: 'El Mago', meaning: 'Poder, manifestación, magia personal' },
        { name: 'La Sacerdotisa', meaning: 'Intuición, secretos, sabiduría interior' }
      ];
      tarotData = {
        cards: cardType === 'diario' ? [demoCards[0]] : demoCards,
        interpretation: 'Tu energía hoy habla de transformación y nuevos comienzos.',
        advice: 'Confía en tu intuición y permite que los cambios fluyan naturalmente.'
      };
    }

    res.json({
      tipo: cardType,
      cartas: tarotData.cards,
      interpretacion: tarotData.interpretation,
      consejo: tarotData.advice,
      fecha: new Date().toISOString().split('T')[0]
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /astrocartografia - Get astrocartography lines
app.post('/astrocartografia', requireLogin, async (req, res) => {
  const { carta_id, ubicacion_lat, ubicacion_lon } = req.body;

  try {
    // Get natal chart
    const { data: chart } = await req.supabase
      .from('cartas_natales')
      .select('data')
      .eq('id', carta_id)
      .eq('usuario_id', req.user.id)
      .single();

    if (!chart) {
      return res.status(404).json({ error: 'Chart not found' });
    }

    // Call Astrology API for astrocartography
    const response = await axios.post(
      `${ASTROLOGY_API_URL}/calculate/astrocartography`,
      {
        natal_chart: chart.data,
        query_latitude: ubicacion_lat,
        query_longitude: ubicacion_lon
      },
      {
        headers: { 'Authorization': `Bearer ${ASTROLOGY_API_KEY}` }
      }
    );

    const astrocartoData = response.data;

    res.json({
      ubicacion: {
        lat: ubicacion_lat,
        lon: ubicacion_lon
      },
      lineas_beneficas: astrocartoData.beneficial_lines,
      lineas_desafiantes: astrocartoData.challenging_lines,
      zonas_poder: astrocartoData.power_zones,
      interpretacion: astrocartoData.interpretation
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /eclipses - Get upcoming eclipses
app.post('/eclipses', requireLogin, async (req, res) => {
  const { cantidad } = req.body;
  const limit = cantidad || 6;

  try {
    let eclipsesData = null;

    try {
      const response = await axios.get(
        `${ASTROLOGY_API_URL}/calculate/eclipses`,
        {
          params: {
            date_from: new Date().toISOString().split('T')[0],
            limit
          },
          headers: { 'Authorization': `Bearer ${ASTROLOGY_API_KEY}` },
          timeout: 5000
        }
      );
      eclipsesData = response.data;
    } catch (apiErr) {
      // Fallback: demo eclipses data
      eclipsesData = {
        eclipses: [
          {
            type: 'lunar',
            date: '2026-09-24',
            time: '12:45',
            zodiac_sign: 'Aries',
            degrees: '2°',
            visibility: 'Visible desde México',
            duration: '1h 24m',
            astrological_effects: 'Liberación, culminación de ciclos'
          },
          {
            type: 'solar',
            date: '2026-10-08',
            time: '14:20',
            zodiac_sign: 'Libra',
            degrees: '15°',
            visibility: 'Visible desde México',
            duration: '2h 15m',
            astrological_effects: 'Nuevos comienzos, transformación'
          }
        ]
      };
    }

    res.json({
      proximos_eclipses: eclipsesData.eclipses.map(eclipse => ({
        tipo: eclipse.type, // 'solar' o 'lunar'
        fecha: eclipse.date,
        hora: eclipse.time,
        signo: eclipse.zodiac_sign,
        grados: eclipse.degrees,
        visibilidad: eclipse.visibility,
        duracion: eclipse.duration,
        efectos_astrologicos: eclipse.astrological_effects
      }))
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============ SUBSCRIPTION ROUTES ============

// POST /suscripcion/iniciar - Start subscription
app.post('/suscripcion/iniciar', requireLogin, async (req, res) => {
  const { token_pago } = req.body;
  if (!token_pago) {
    return res.status(400).json({ error: 'Payment token required' });
  }

  try {
    // Create Stripe customer
    const customer = await stripe.customers.create({
      email: req.user.email,
      source: token_pago
    });

    // Create subscription
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: process.env.STRIPE_PRICE_ID }]
    });

    // Save subscription to database
    const { data, error } = await req.supabase
      .from('suscripciones')
      .insert([
        {
          usuario_id: req.user.id,
          stripe_customer_id: customer.id,
          stripe_subscription_id: subscription.id,
          status: subscription.status,
          created_at: new Date()
        }
      ])
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /webhooks/stripe - Stripe webhook handler
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        const subscription = event.data.object;
        await supabase
          .from('suscripciones')
          .update({ status: subscription.status })
          .eq('stripe_subscription_id', subscription.id);
        break;
    }

    res.json({ received: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============ HELPER FUNCTIONS ============

// Generate demo chart data for fallback
function generateDemoChart() {
  return {
    planets: {
      sun: { sign: 'Virgo', degree: 150, house: 10 },
      moon: { sign: 'Cancer', degree: 85, house: 7 },
      mercury: { sign: 'Virgo', degree: 155, house: 10 },
      venus: { sign: 'Libra', degree: 175, house: 11 },
      mars: { sign: 'Scorpio', degree: 195, house: 12 },
      jupiter: { sign: 'Gemini', degree: 45, house: 4 },
      saturn: { sign: 'Pisces', degree: 15, house: 1 },
      uranus: { sign: 'Taurus', degree: 55, house: 5 },
      neptune: { sign: 'Pisces', degree: 25, house: 2 },
      pluto: { sign: 'Capricorn', degree: 340, house: 12 }
    },
    ascendant: { sign: 'Libra', degree: 180 },
    midheaven: { sign: 'Cancer', degree: 90 }
  };
}

// Generate SVG representation of natal chart wheel
function generateNatalChartSVG(chart) {
  const size = 400;
  const center = size / 2;
  const outerRadius = 140;

  let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">`;

  // Background
  svg += `<circle cx="${center}" cy="${center}" r="${outerRadius}" fill="#fdf8f6" stroke="#b5652f" stroke-width="3"/>`;

  // Inner circles
  svg += `<circle cx="${center}" cy="${center}" r="${outerRadius * 0.7}" fill="none" stroke="#b5652f" stroke-width="1" opacity="0.5"/>`;
  svg += `<circle cx="${center}" cy="${center}" r="${outerRadius * 0.4}" fill="none" stroke="#b5652f" stroke-width="1" opacity="0.5"/>`;

  // Draw zodiac signs (outer ring)
  const signs = ['♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓'];
  const signNames = ['Aries', 'Tauro', 'Géminis', 'Cáncer', 'Leo', 'Virgo', 'Libra', 'Escorpio', 'Sagitario', 'Capricornio', 'Acuario', 'Piscis'];

  signs.forEach((sign, i) => {
    const angle = (i * 30 - 90) * Math.PI / 180;
    // Symbol
    const sx = center + Math.cos(angle) * (outerRadius + 20);
    const sy = center + Math.sin(angle) * (outerRadius + 20);
    svg += `<text x="${sx}" y="${sy}" text-anchor="middle" dominant-baseline="middle" font-size="16" font-weight="bold" fill="#6b3f87">${sign}</text>`;

    // Lines from center
    const x1 = center + Math.cos(angle) * (outerRadius * 0.3);
    const y1 = center + Math.sin(angle) * (outerRadius * 0.3);
    const x2 = center + Math.cos(angle) * outerRadius;
    const y2 = center + Math.sin(angle) * outerRadius;
    svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#b5652f" stroke-width="1" opacity="0.3"/>`;
  });

  // Draw planets
  if (chart.planets) {
    const planetSymbols = {
      sun: '☀', moon: '☾', mercury: '☿', venus: '♀', mars: '♂',
      jupiter: '♃', saturn: '♄', uranus: '♅', neptune: '♆', pluto: '♇'
    };

    Object.entries(chart.planets).forEach(([planetName, position]) => {
      if (!position || position.degree === undefined) return;

      const angle = (position.degree - 90) * Math.PI / 180;
      const radiusOffset = Math.random() * 40 + 60;
      const x = center + Math.cos(angle) * radiusOffset;
      const y = center + Math.sin(angle) * radiusOffset;

      // Planet dot
      svg += `<circle cx="${x}" cy="${y}" r="6" fill="#b5652f" stroke="#fff" stroke-width="1"/>`;

      // Planet symbol
      const symbol = planetSymbols[planetName] || '●';
      svg += `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-size="10" font-weight="bold" fill="#fff">${symbol}</text>`;

      // Label
      svg += `<text x="${x}" y="${y + 18}" text-anchor="middle" font-size="9" fill="#3a1f38">${planetName}</text>`;
    });
  }

  // Center point
  svg += `<circle cx="${center}" cy="${center}" r="4" fill="#6b3f87"/>`;

  svg += `</svg>`;
  return svg;
}

// Start server
app.listen(PORT, () => {
  console.log(`✨ Sam Alquimia Astral API running on http://localhost:${PORT}`);
  console.log(`🌙 All astrological features ready!`);
});

module.exports = app;
