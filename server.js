// ============================================================
// SAM ALQUIMIA ASTRAL — Servidor (el "cerebro" de la app)
// ============================================================
// Este archivo conecta 3 piezas:
//   1. Supabase   -> guarda usuarias y sus datos, de forma privada
//   2. Astrology API (astrology-api.io) -> calcula cartas natales, sinastría, etc.
//   3. Stripe     -> cobra la suscripción mensual (se conecta en el siguiente paso)
//
// No necesitas entender cada línea. Los comentarios explican qué hace cada bloque.
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use((req, res, next) => {
  if (req.originalUrl === '/webhooks/stripe') return next(); // este necesita el "cuerpo crudo", se procesa aparte
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
// (revisa el "token" que manda la app después del login)
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

  // IMPORTANTE: creamos un "cliente" de Supabase que lleva el pase de ESTA usuaria
  // en cada consulta, para que la regla de seguridad (RLS) la reconozca correctamente.
  req.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  next();
}

// ============================================================
// RUTA: Registro de nueva usuaria
// POST /auth/registro   { email, password }
// ============================================================
app.post('/auth/registro', async (req, res) => {
  const { email, password } = req.body;

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });

  res.json({ mensaje: 'Cuenta creada', usuario: data.user });
});

// ============================================================
// RUTA: Inicio de sesión
// POST /auth/login   { email, password }
// ============================================================
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: error.message });

  // "session.access_token" es el "pase" que la app usará en las siguientes peticiones
  res.json({ sesion: data.session, usuario: data.user });
});

// ============================================================
// RUTA: Guardar/actualizar los datos de nacimiento de la usuaria
// POST /perfil   (requiere estar logueada)
// { nombre, fecha_nacimiento, hora_nacimiento, lugar_nacimiento, latitud, longitud }
// ============================================================
app.post('/perfil', requireLogin, async (req, res) => {
  const { nombre, fecha_nacimiento, hora_nacimiento, lugar_nacimiento, latitud, longitud } = req.body;

  const { data, error } = await req.supabase
    .from('profiles')
    .upsert({
      id: req.userId,
      nombre,
      fecha_nacimiento,
      hora_nacimiento,
      lugar_nacimiento,
      latitud,
      longitud,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ mensaje: 'Perfil guardado', perfil: data });
});

// ============================================================
// RUTA: Calcular la carta natal REAL con Astrology API
// POST /carta-natal   (requiere estar logueada)
// ============================================================
app.post('/carta-natal', requireLogin, async (req, res) => {
  try {
    // 1) Leemos el perfil de la usuaria (sus datos de nacimiento) desde Supabase
    const { data: perfil, error: errorPerfil } = await req.supabase
      .from('profiles')
      .select('*')
      .eq('id', req.userId)
      .single();

    if (errorPerfil || !perfil) {
      return res.status(400).json({ error: 'Primero guarda tu fecha y lugar de nacimiento en tu perfil.' });
    }

    const [anio, mes, dia] = perfil.fecha_nacimiento.split('-').map(Number);
    const [hora, minuto] = (perfil.hora_nacimiento || '12:00').split(':').map(Number);

    // 2) Le pedimos a Astrology API que calcule la carta real
    const respuesta = await astrologyApi.post('/charts/natal', {
      subject: {
        name: perfil.nombre || 'Usuaria',
        birth_data: {
          year: anio,
          month: mes,
          day: dia,
          hour: hora,
          minute: minuto,
          second: 0,
          latitude: perfil.latitud,
          longitude: perfil.longitud,
        },
      },
      options: {
        house_system: 'P',       // Placidus, el sistema de casas más usado
        zodiac_type: 'Tropic',   // astrología occidental (tropical), no védica
        language: 'es',
      },
    });

    // 3) Guardamos el resultado en la tabla natal_charts, ligado a esta usuaria
    const { data: cartaGuardada, error: errorGuardar } = await req.supabase
      .from('natal_charts')
      .insert({
        user_id: req.userId,
        datos_carta: respuesta.data,
      })
      .select()
      .single();

    if (errorGuardar) return res.status(400).json({ error: errorGuardar.message });

    res.json({ mensaje: 'Carta natal calculada', carta: cartaGuardada });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({
      error: 'No se pudo calcular la carta. Revisa los datos de nacimiento.',
      detalle_tecnico: err?.response?.data || err.message, // TEMPORAL: para diagnosticar, quitar después
    });
  }
});

// ============================================================
// RUTA: Iniciar el cobro de la suscripción mensual ($8.88 USD)
// POST /suscripcion/iniciar   (requiere estar logueada)
// Devuelve una URL de pago de Stripe (Checkout) para que la usuaria pague ahí.
// ============================================================
app.post('/suscripcion/iniciar', requireLogin, async (req, res) => {
  try {
    // Buscamos el correo de la usuaria para pre-llenarlo en el formulario de pago
    const { data: userData } = await supabase.auth.admin.getUserById(req.userId);
    const email = userData?.user?.email;

    const sesionPago = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      // Estas dos URLs las ajustaremos cuando la app esté publicada (paso 4)
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
// RUTA: Webhook de Stripe — Stripe nos avisa aquí cuando un pago
// se completó, para activar la suscripción de la usuaria en Supabase.
// (Esta ruta la conectamos con Stripe hasta el paso 4, cuando
// tengamos una dirección de internet real para recibir el aviso)
// ============================================================
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  // Por ahora dejamos el esqueleto listo; se activa al desplegar (paso 4)
  res.json({ recibido: true });
});

// ============================================================
// Arrancar el servidor
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sam Alquimia Astral backend corriendo en http://localhost:${PORT}`);
});
