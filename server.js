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

  // Si cambió fecha/hora/lugar de nacimiento, borramos la carta guardada
  // para que la próxima consulta calcule una fresca con los datos correctos
  await req.supabase.from('natal_charts').delete().eq('user_id', req.userId);

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
    // 1) ¿Ya la calculamos antes? Si sí, la regresamos sin gastar créditos
    const { data: yaExiste } = await req.supabase
      .from('natal_charts')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (yaExiste && !req.body?.forzar) {
      return res.json({ mensaje: 'Carta natal (guardada)', carta: yaExiste, desde_cache: true });
    }

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

    res.json({ mensaje: 'Carta natal calculada', carta: cartaGuardada, desde_cache: false });
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
    // 1) Buscamos la carta guardada de esta usuaria
    const { data: cartaExistente } = await req.supabase
      .from('natal_charts')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // 2) Si ya tiene el dibujo guardado, lo regresamos sin gastar créditos
    if (cartaExistente?.svg_visual && !req.body?.forzar) {
      return res.json({ svg: cartaExistente.svg_visual, desde_cache: true });
    }

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

    // 3) Guardamos el dibujo para la próxima vez, si tenemos dónde guardarlo
    if (svg && cartaExistente?.id) {
      await req.supabase.from('natal_charts').update({ svg_visual: svg }).eq('id', cartaExistente.id);
    }

    res.json({ svg, crudo: svg ? undefined : respuesta.data, desde_cache: false });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar la carta visual.', detalle_tecnico: err?.response?.data || err.message });
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
    const { data: cartaExistente } = await req.supabase
      .from('natal_charts')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cartaExistente?.resumen_cache && !req.body?.forzar) {
      return res.json({ reporte: cartaExistente.resumen_cache, desde_cache: true });
    }

    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const respuesta = await astrologyApi.post('/analysis/natal-report', {
      subject: birthDataDesdePerfil(perfil),
      report_options: { tradition: 'psychological', language: 'es' },
    });

    if (cartaExistente?.id) {
      await req.supabase.from('natal_charts').update({ resumen_cache: respuesta.data }).eq('id', cartaExistente.id);
    }

    res.json({ reporte: respuesta.data, desde_cache: false });
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

    const ahora = new Date();
    const respuesta = await astrologyApi.post('/charts/natal', {
      subject: {
        name: 'Hoy',
        birth_data: {
          year: ahora.getUTCFullYear(), month: ahora.getUTCMonth() + 1, day: ahora.getUTCDate(),
          hour: ahora.getUTCHours(), minute: ahora.getUTCMinutes(), second: 0,
          city: 'Greenwich', country_code: 'GB',
        },
      },
      options: { house_system: 'P', zodiac_type: 'Tropic', language: 'es' },
    });

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
    let datosSubject;
    if (req.body?.otra_carta_id) {
      const { data: persona, error } = await req.supabase.from('otras_cartas').select('*').eq('id', req.body?.otra_carta_id).single();
      if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta.' });
      datosSubject = birthDataDesdePerfil(persona, persona.nombre);
    } else {
      const perfil = await leerPerfil(req);
      if (!perfil) return res.status(400).json({ error: 'Primero guarda tu fecha y lugar de nacimiento en tu perfil.' });
      datosSubject = birthDataDesdePerfil(perfil);
    }

    const respuesta = await astrologyApi.post('/astrocartography/map', {
      subject: datosSubject,
      map_options: {
        planets: ['Sun', 'Moon', 'Venus', 'Jupiter', 'Mars'],
        line_types: ['AC', 'MC'],
        map_projection: 'mercator',
      },
      visual_options: {
        width: 1000, height: 500, theme: 'modern', show_legend: true,
        city_min_population: 500000, language: 'es',
      },
    });

    res.json({
      svg: respuesta.data?.svg_content || null,
      zonas_poder: respuesta.data?.map_data?.power_zones || [],
      lineas: respuesta.data?.map_data?.lines || [],
      ciudades: respuesta.data?.map_data?.cities_shown || [],
    });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar la astrocartografía.', detalle_tecnico: err?.response?.data || err.message });
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

    let datosOtraPersona;
    let personaGuardada = null;

    if (req.body?.otra_carta_id) {
      // Opción A: usar una carta ya guardada
      const { data: persona, error } = await req.supabase
        .from('otras_cartas')
        .select('*')
        .eq('id', req.body?.otra_carta_id)
        .single();
      if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta guardada.' });
      personaGuardada = persona;

      // ¿Ya calculamos esta sinastría antes? Si sí, la regresamos sin gastar créditos
      if (persona.sinastria_cache) {
        return res.json({ reporte: persona.sinastria_cache, desde_cache: true });
      }
      datosOtraPersona = birthDataDesdePerfil(persona, persona.nombre);
    } else {
      // Opción B: datos escritos a mano (no se guarda en caché)
      const { nombre, fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo } = req.body;
      if (!nombre || !fecha_nacimiento || !ciudad_nacimiento || !pais_codigo) {
        return res.status(400).json({ error: 'Faltan datos de la otra persona.' });
      }
      datosOtraPersona = birthDataDesdePerfil({ fecha_nacimiento, hora_nacimiento, ciudad_nacimiento, pais_codigo }, nombre);
    }

    const respuesta = await astrologyApi.post('/analysis/synastry-report', {
      subject1: birthDataDesdePerfil(perfil),
      subject2: datosOtraPersona,
      options: { house_system: 'P', zodiac_type: 'Tropic' },
      report_options: { tradition: 'psychological', language: 'es' },
    });

    if (personaGuardada) {
      await req.supabase.from('otras_cartas').update({ sinastria_cache: respuesta.data }).eq('id', personaGuardada.id);
    }

    res.json({ reporte: respuesta.data, desde_cache: false });
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

// RUTA: Resumen de personalidad de una carta guardada (otra persona)
app.post('/otras-cartas/:id/resumen', requireLogin, async (req, res) => {
  try {
    const { data: persona, error } = await req.supabase
      .from('otras_cartas')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta.' });

    if (persona.resumen_cache) {
      return res.json({ reporte: persona.resumen_cache, desde_cache: true });
    }

    const respuesta = await astrologyApi.post('/analysis/natal-report', {
      subject: birthDataDesdePerfil(persona, persona.nombre),
      report_options: { tradition: 'psychological', language: 'es' },
    });

    await req.supabase.from('otras_cartas').update({ resumen_cache: respuesta.data }).eq('id', persona.id);

    res.json({ reporte: respuesta.data, desde_cache: false });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar el resumen.', detalle_tecnico: err?.response?.data || err.message });
  }
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

    if (persona.svg_visual) {
      return res.json({ svg: persona.svg_visual, desde_cache: true });
    }

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

    if (svg) await req.supabase.from('otras_cartas').update({ svg_visual: svg }).eq('id', persona.id);

    res.json({ svg, desde_cache: false });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo generar la carta visual.', detalle_tecnico: err?.response?.data || err.message });
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

// RUTA: Calendario lunar del mes — mejores días específicos por actividad
app.post('/calendario-lunar', requireLogin, async (req, res) => {
  try {
    const hoy = new Date();
    const anio = hoy.getUTCFullYear();
    const mes = hoy.getUTCMonth() + 1;
    const diasEnMes = new Date(Date.UTC(anio, mes, 0)).getUTCDate();

    const dias = Array.from({ length: diasEnMes }, (_, i) => i + 1);

    const resultados = await Promise.all(dias.map(async (dia) => {
      try {
        const r = await astrologyApi.post('/analysis/lunar-analysis', {
          datetime_location: {
            year: anio, month: mes, day: dia, hour: 12, minute: 0, second: 0,
            city: 'Mexico City', country_code: 'MX',
          },
          report_options: { language: 'es' },
        });
        const m = r.data?.data?.lunar_metrics;
        return { dia, signo: m?.moon_sign, fase: m?.moon_phase };
      } catch (e) {
        return { dia, signo: null, fase: null };
      }
    }));

    const creciente = f => f && f.includes('Waxing');
    const menguante = f => f && f.includes('Waning');
    const nueva = f => f === 'New Moon';

    const calendario = {
      cortarte_el_cabello: resultados.filter(d => creciente(d.fase) && ['Tau', 'Leo'].includes(d.signo)).map(d => d.dia),
      tatuarte: resultados.filter(d => menguante(d.fase) && d.signo !== 'Sco').map(d => d.dia),
      lanzar_negocio: resultados.filter(d => nueva(d.fase) || (creciente(d.fase) && d.dia <= 10)).map(d => d.dia),
      pedir_credito: resultados.filter(d => creciente(d.fase) && ['Tau', 'Cap'].includes(d.signo)).map(d => d.dia),
      cirugias: resultados.filter(d => menguante(d.fase) && d.signo !== 'Sco').map(d => d.dia),
    };

    res.json({ mes, anio, calendario, detalle_dias: resultados });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular el calendario lunar.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Relocación — cómo cambia tu carta si vives en otro lugar
app.post('/relocacion', requireLogin, async (req, res) => {
  try {
    const perfil = await leerPerfil(req);
    if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });

    const { ciudad, pais_codigo } = req.body;
    if (!ciudad || !pais_codigo) return res.status(400).json({ error: 'Falta la ciudad donde vives ahora.' });

    const respuesta = await astrologyApi.post('/analysis/relocation', {
      subject: birthDataDesdePerfil(perfil),
      options: {
        target_location: { city: ciudad, country_code: pais_codigo },
        show_changes: true,
        highlight_angular_changes: true,
      },
    });

    res.json({ relocacion: respuesta.data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular la relocación.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Numerología (números núcleo: camino de vida, destino, etc.)
app.post('/numerologia', requireLogin, async (req, res) => {
  try {
    let datosSubject;
    if (req.body?.otra_carta_id) {
      const { data: persona, error } = await req.supabase.from('otras_cartas').select('*').eq('id', req.body?.otra_carta_id).single();
      if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta.' });
      datosSubject = birthDataDesdePerfil(persona, persona.nombre);
    } else {
      const perfil = await leerPerfil(req);
      if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });
      datosSubject = birthDataDesdePerfil(perfil);
    }

    const respuesta = await astrologyApi.post('/numerology/core-numbers', {
      subject: datosSubject,
      language: 'es',
    });

    res.json({ numerologia: respuesta.data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudo calcular la numerología.', detalle_tecnico: err?.response?.data || err.message });
  }
});

// RUTA: Estrellas fijas — cuáles tocan tu carta (propia o guardada)
app.post('/estrellas-fijas', requireLogin, async (req, res) => {
  try {
    let datosSubject;
    if (req.body?.otra_carta_id) {
      const { data: persona, error } = await req.supabase.from('otras_cartas').select('*').eq('id', req.body?.otra_carta_id).single();
      if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta.' });
      datosSubject = birthDataDesdePerfil(persona, persona.nombre);
    } else {
      const perfil = await leerPerfil(req);
      if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });
      datosSubject = birthDataDesdePerfil(perfil);
    }

    const respuesta = await astrologyApi.post('/fixed-stars/report', {
      subject: datosSubject,
      language: 'es',
    });

    res.json({ estrellas: respuesta.data });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'No se pudieron calcular las estrellas fijas.', detalle_tecnico: err?.response?.data || err.message });
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
    let datosSubject;
    if (req.body?.otra_carta_id) {
      const { data: persona, error } = await req.supabase.from('otras_cartas').select('*').eq('id', req.body?.otra_carta_id).single();
      if (error || !persona) return res.status(400).json({ error: 'No se encontró esa carta.' });
      datosSubject = birthDataDesdePerfil(persona, persona.nombre);
    } else {
      const perfil = await leerPerfil(req);
      if (!perfil) return res.status(400).json({ error: 'Primero guarda tu perfil.' });
      datosSubject = birthDataDesdePerfil(perfil);
    }

    const numeroArmonico = req.body?.numero || 5;
    const respuesta = await astrologyApi.post('/charts/harmonic', {
      subject: datosSubject,
      n: numeroArmonico,
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
    // Buscamos si ya existe un customer_id guardado; si no, creamos uno en Stripe
    const { data: subExistente } = await req.supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', req.userId)
      .maybeSingle();

    let customerId = subExistente?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.userEmail });
      customerId = customer.id;
      await req.supabase.from('subscriptions').upsert({
        user_id: req.userId,
        stripe_customer_id: customerId,
        estado: 'pendiente',
      }, { onConflict: 'user_id' });
    }

    const sesionPago = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: customerId,
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
// RUTA: Abrir el portal de Stripe para gestionar/cancelar la suscripción
app.post('/suscripcion/portal', requireLogin, async (req, res) => {
  try {
    const { data: sub } = await req.supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', req.userId)
      .maybeSingle();

    if (!sub?.stripe_customer_id) {
      return res.status(400).json({ error: 'Aún no tienes una suscripción activa para gestionar.' });
    }

    const sesion = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: req.headers.origin || 'https://tuapp.com',
    });

    res.json({ url: sesion.url });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'No se pudo abrir el portal de pago.' });
  }
});

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
