// ============================================================
// SAM ALQUIMIA ASTRAL — Servidor (el "cerebro" de la app)
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use((req, res, next) => {
  if (req.originalUrl === '/webhooks/stripe') return next();
  express.json()(req, res, next);
});
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.json({ estado: 'Sam Alquimia Astral backend funcionando ✅', prueba: '/probar.html' });
});

// ---- Conexión a Supabase ----
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ---- Conexión a Stripe (cobros) ----
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ---- Conexión a Astrology API ----
const astrologyApi = axios.create({
  baseURL: process.env.ASTROLOGY_API_BASE_URL,
  headers: {
    Authorization: `Bearer ${process.env.ASTROLOGY_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

// ============================================================
// Middleware: verifica que la usuaria haya iniciado sesión
// ============================================================
async function requireLogin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No iniciaste sesión.' });
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Sesión inválida o expirada.' });
  }

  req.userId = data.user.id;
  req.userEmail = data.user.email;

  // Cliente de Supabase con el "pase" de ESTA usuaria, para que RLS funcione
  req.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  next();
}

// Helper: arma el objeto subject.birth_data a partir del perfil guardado
function birthDataDesdePerfil(perfil, nombre) {
  const [anio, mes, dia] = perfil.fecha_nacimiento.split('-').map(Number);
  const [hora, minuto] = (perfil.hora_nacimiento || '12:00').split(':').map(Number);
  return {
    name: nombre || perfil.nombre || 'Usuaria',
    birth_data: {
      year: anio, month: mes, day: dia, hour: hora, minute: minuto, second: 0,
      city: perfil.ciudad_nacimiento,
      country_code: perfil.pais_codigo,
    },
  };
}

async function leerPerfil(req) {
  const { data: perfil, error } = await req.supabase
    .from('profiles')
    .select('*')
    .eq('id', req.userId)
    .single();
  if (error || !perfil) return null;
  return perfil;
}

// ============================================================
// RUTA: Registro de nueva usuaria
// ============================================================
app.post('/auth/registro', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ mensaje: 'Cuenta creada', usuario: data.user });
});

// ============================================================
// RUTA: Inicio de sesión
// ============================================================
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ sesion: data.session, usuario: data.user });
});

// ============================================================
// RUTA: Guardar/actualizar el perfil (ciudad + país)
// ============================================================
app.post('/perfil', requireLogin, async (req, res) => {
  const { nombre, fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo } = req.body;

  const { data, error } = await req.supabase
    .from('profiles')
    .upsert({
      id: req.userId,
      nombre,
      fecha_nacimiento,
      hora_nacimiento,
      ciudad_nacimiento,
      pais_codigo,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ mensaje: 'Perfil guardado', perfil: data });
});

// RUTA: Leer el perfil actual de la usuaria
app.get('/perfil', requireLogin, async (req, res) => {
  const { data, error } = await req.supabase
    .from('profiles')
    .select('*')
    .eq('id', req.userId)
    .maybeSingle();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ perfil: data });
});

// ============================================================
// RUTA: Calcular la carta natal REAL (texto: Sol, Luna, etc.)
// ============================================================
app.post('/carta-natal', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) {
      return res.status(400).json({ error: 'Primero guarda tu fecha y lugar de nacimiento en tu perfil.' });
    }

    const respuesta = await astrologyApi.post('/charts/natal', {
      subject: birthDataDesdePerfil(perfil),
      options: { house_system: 'P', zodiac_type: 'Tropic', language: 'es' },
    });

    const { data: cartaGuardada, error: errorGuardar } = await req.supabase
      .from('natal_charts')
      .insert({ user_id: req.userId, datos_carta: respuesta.data })
      .select()
      .single();

    if (errorGuardar) return res.status(400).json({ error: errorGuardar.message });

    res.json({ mensaje: 'Carta natal calculada', carta: cartaGuardada });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular la carta. Revisa los datos de nacimiento.' });
  }
});

// ============================================================
// RUTA: Generar la carta natal VISUAL (la "rueda" en SVG)
// ============================================================
app.post('/carta-visual', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) {
      return res.status(400).json({ error: 'Primero guarda tu fecha y lugar de nacimiento en tu perfil.' });
    }

    const respuesta = await astrologyApi.post('/render/natal', {
      subject: birthDataDesdePerfil(perfil),
      options: { house_system: 'P' },
      render_options: { format: 'svg', theme: 'light' },
    });

    let svg = null;
    const crudoTexto = typeof respuesta.data === 'string' ? respuesta.data : JSON.stringify(respuesta.data);
    const inicioSvg = crudoTexto.indexOf('<svg');
    if (inicioSvg !== -1) {
      svg = crudoTexto.slice(inicioSvg);
    } else if (respuesta.data?.svg_content) {
      svg = respuesta.data.svg_content;
    } else if (respuesta.data?.svg) {
      svg = respuesta.data.svg;
    }

    res.json({ svg, crudo: svg ? undefined : respuesta.data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar la carta visual.' });
  }
});

// ============================================================
// RUTA: Fase lunar de HOY (real)
// ============================================================
// RUTA: Leer la última carta natal ya calculada (para mostrar Sol/Asc/Luna al abrir la app)
app.get('/carta-natal/ultima', requireLogin, async (req, res) => {
  const { data, error } = await req.supabase
    .from('natal_charts')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ carta: data });
});

// RUTA: Resumen/reporte de personalidad de la carta natal (en español)
app.post('/resumen-natal', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const respuesta = await astrologyApi.post('/analysis/natal-report', {
      subject: birthDataDesdePerfil(perfil),
      report_options: { tradition: 'psychological', language: 'es' },
    });

    res.json({ reporte: respuesta.data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar el resumen.', detalle_tecnico: err?.response?.data || err.message });
  }
});

app.post('/luna', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    const ahora = new Date();

    const respuesta = await astrologyApi.post('/analysis/lunar-analysis', {
      datetime_location: {
        year: ahora.getUTCFullYear(),
        month: ahora.getUTCMonth() + 1,
        day: ahora.getUTCDate(),
        hour: ahora.getUTCHours(),
        minute: ahora.getUTCMinutes(),
        second: 0,
        city: perfil?.ciudad_nacimiento || 'Mexico City',
        country_code: perfil?.pais_codigo || 'MX',
      },
      report_options: { language: 'es' },
    });

    res.json({ mensaje: 'Datos lunares de hoy', luna: respuesta.data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({
      error: 'No se pudo obtener la fase lunar.',
      detalle_tecnico: err?.response?.data || err.message,
    });
  }
});

// ============================================================
// RUTA: Mensaje del día (Sol/Luna de hoy + tu carta real)
// ============================================================
app.post('/mensaje-del-dia', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) {
      return res.status(400).json({ error: 'Primero guarda tu perfil.' });
    }

    const respuesta = await astrologyApi.get('/data/now');

    res.json({
      mensaje: 'Mensaje del día',
      datos_hoy: respuesta.data,
      nombre: perfil.nombre,
    });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar el mensaje del día.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// ============================================================
// RUTA: Astrocartografía (mapa mundial de líneas planetarias)
// ============================================================
app.post('/astrocartografia', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) {
      return res.status(400).json({ error: 'Primero guarda tu fecha y lugar de nacimiento en tu perfil.' });
    }

    const respuesta = await astrologyApi.post('/astrocartography/map', {
      subject: birthDataDesdePerfil(perfil),
      map_options: {
        planets: ['Sun', 'Moon', 'Venus', 'Jupiter', 'Mars'],
        line_types: ['AC', 'MC'],
        map_projection: 'mercator',
      },
      visual_options: {
        width: 1000, height: 500, theme: 'modern', show_legend: true,
        city_min_population: 750000, language: 'es',
      },
    });

    res.json({
      svg: respuesta.data?.svg_content || null,
      zonas_poder: respuesta.data?.map_data?.power_zones || [],
      lineas: respuesta.data?.map_data?.lines || [],
    });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar la astrocartografía.' });
  }
});

// ============================================================
// RUTA: Iniciar el cobro de la suscripción mensual ($8.88 USD)
// ============================================================
// RUTA: Sinastría (compatibilidad) entre la usuaria y otra persona
app.post('/sinastria', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const { nombre, fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo } = req.body;
    if (!nombre || !fecha_nacimiento || !ciudad_nacimiento || !pais_codigo) {
      return res.status(400).json({ error: 'Faltan datos de la otra persona.' });
    }

    const respuesta = await astrologyApi.post('/analysis/synastry-report', {
      subject1: birthDataDesdePerfil(perfil),
      subject2: birthDataDesdePerfil(
        { fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo },
        nombre
      ),
      options: { house_system: 'P', zodiac_type: 'Tropic' },
      report_options: { tradition: 'psychological', language: 'es' },
    });

    res.json({ reporte: respuesta.data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular la sinastría.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Flor armónica (harmonic chart)
// RUTA: Horóscopo diario personalizado (real)
// RUTA: Ver el detalle completo de una carta guardada
app.get('/otras-cartas/:id', requireLogin, async (req, res) => {
  const { data, error } = await req.supabase
    .from('otras_cartas')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ carta: data });
});

// RUTA: Generar la carta visual (rueda) de una persona guardada
app.post('/otras-cartas/:id/visual', requireLogin, async (req, res) => {
  try {
    const { data: persona, error } = await req.supabase
      .from('otras_cartas')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta.' });

    const respuesta = await astrologyApi.post('/render/natal', {
      subject: birthDataDesdePerfil(persona, persona.nombre),
      options: { house_system: 'P' },
      render_options: { format: 'svg', theme: 'light' },
    });

    let svg = null;
    const crudoTexto = typeof respuesta.data === 'string' ? respuesta.data : JSON.stringify(respuesta.data);
    const inicioSvg = crudoTexto.indexOf('<svg');
    if (inicioSvg !== -1) svg = crudoTexto.slice(inicioSvg);
    else if (respuesta.data?.svg_content) svg = respuesta.data.svg_content;

    res.json({ svg });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar la carta visual.' });
  }
});

// RUTA: Guardar y calcular la carta de otra persona (familia, pareja, amigas — hasta 8)
app.post('/otras-cartas', requireLogin, async (req, res) => {
  try {
    const { nombre, fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo } = req.body;
    if (!nombre || !fecha_nacimiento || !ciudad_nacimiento || !pais_codigo) {
      return res.status(400).json({ error: 'Faltan datos de la persona.' });
    }

    const { count } = await req.supabase.from('otras_cartas').select('*', { count: 'exact', head: true });
    if (count >= 8) return res.status(400).json({ error: 'Ya tienes 8 cartas guardadas (el máximo).' });

    const respuesta = await astrologyApi.post('/charts/natal', {
      subject: birthDataDesdePerfil({ fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo }, nombre),
      options: { house_system: 'P', zodiac_type: 'Tropic', language: 'es' },
    });

    const { data, error } = await req.supabase
      .from('otras_cartas')
      .insert({
        user_id: req.userId, nombre, fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo,
        datos_carta: respuesta.data,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ mensaje: 'Carta guardada', carta: data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular/guardar la carta.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Listar las cartas de otras personas ya guardadas
app.get('/otras-cartas', requireLogin, async (req, res) => {
  const { data, error } = await req.supabase
    .from('otras_cartas')
    .select('id, nombre, fecha_nacimiento, ciudad_nacimiento, created_at')
    .order('created_at', { ascending: true });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ cartas: data || [] });
});

// RUTA: Próximos eclipses y cómo afectan tu carta natal
app.post('/eclipses-natal', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const [proximos, revision] = await Promise.all([
      astrologyApi.get('/eclipses/upcoming').catch(err => ({ error: err?.response?.data || err.message })),
      astrologyApi.post('/eclipses/natal-check', {
        subject: birthDataDesdePerfil(perfil),
      }).catch(err => ({ error: err?.response?.data || err.message })),
    ]);

    res.json({
      proximos_eclipses: proximos.data || proximos,
      como_te_afecta: revision.data || revision,
    });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo consultar eclipses.', detalle_tecnico: err?.response?.data || err.message });
  }
});

app.post('/horoscopo-diario', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const respuesta = await astrologyApi.post('/horoscope/personal/daily/text', {
      subject: birthDataDesdePerfil(perfil),
      options: { language: 'es' },
    });

    res.json({ horoscopo: respuesta.data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar el horóscopo.', detalle_tecnico: err?.response?.data || err.message });
  }
});

app.post('/flor-armonica', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const numeroArmonico = req.body.numero || 5;
    const respuesta = await astrologyApi.post('/charts/harmonic', {
      subject: birthDataDesdePerfil(perfil),
      harmonic_number: numeroArmonico,
      options: { house_system: 'P', zodiac_type: 'Tropic', language: 'es' },
    });

    res.json({ flor: respuesta.data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular la flor armónica.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Tránsitos personalizados (próximos 30 días)
app.post('/transitos-personales', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const hoy = new Date();
    const en30dias = new Date(hoy.getTime() + 30 * 24 * 60 * 60 * 1000);

    const respuesta = await astrologyApi.post('/analysis/natal-transit-report', {
      subject: birthDataDesdePerfil(perfil),
      transit_time: {
        date_range: {
          start_date: { year: hoy.getUTCFullYear(), month: hoy.getUTCMonth() + 1, day: hoy.getUTCDate() },
          end_date: { year: en30dias.getUTCFullYear(), month: en30dias.getUTCMonth() + 1, day: en30dias.getUTCDate() },
        },
      },
      orb: 1,
      report_options: { tradition: 'psychological', language: 'es' },
    });

    res.json({ transitos: respuesta.data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudieron calcular los tránsitos.', detalle_tecnico: err?.response?.data || err.message });
  }
});

app.post('/suscripcion/iniciar', requireLogin, async (req, res) => {
  try {
    const sesionPago = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: req.userEmail,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${req.headers.origin || 'https://tuapp.com'}/pago-exitoso`,
      cancel_url: `${req.headers.origin || 'https://tuapp.com'}/pago-cancelado`,
      metadata: { user_id: req.userId },
    });

    res.json({ url: sesionPago.url });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'No se pudo iniciar el pago.' });
  }
});

// ============================================================
// RUTA: Webhook de Stripe (esqueleto, se activa al conectar dominio real)
// ============================================================
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  res.json({ recibido: true });
});

// ============================================================
// Arrancar el servidor
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sam Alquimia Astral backend corriendo en http://localhost:${PORT}`);
});
