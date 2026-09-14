<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sam Alquimia Astral — App móvil</title>
<link rel="manifest" href="manifest.json">
<meta name="theme-color" content="#331e37">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Alquimia Astral">
<link rel="apple-touch-icon" href="icons/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;0,700;1,500&family=Work+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --plum:#3a1f38;
    --ink-dim:#7d6b78;
    --marigold:#b5652f;
    --marigold-soft:rgba(181,101,47,0.13);
    --lilac:#6b3f87;
    --blush-1:#4a2f4f;
    --blush-2:#331e37;
    --band-text:#f2e6ec;
    --band-text-dim:#cdb4c4;
    --paper:#fdf8f6;
    --page-bg:#f1e6e0;
    --line:#ecdfe0;
    --moon-navy:#241a38;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;background:#e9e2da;font-family:'Work Sans',sans-serif;color:var(--plum);}
  h1,h2,h3,.display{font-family:'Cormorant Garamond',serif;font-weight:700;margin:0;}
  .page{display:flex;justify-content:center;padding:36px 12px;}

  /* ---------- phone frame ---------- */
  .phone{
    width:380px;max-width:100%;
    background:#111;border-radius:46px;padding:12px;
    box-shadow:0 30px 60px rgba(20,10,20,0.35);
  }
  .screen{
    background:var(--page-bg);
    border-radius:34px;overflow:hidden;
    height:800px;display:flex;flex-direction:column;
    position:relative;
  }
  .notch{
    height:26px;display:flex;align-items:center;justify-content:center;
    background:var(--paper);flex:none;
  }
  .notch .pill{width:90px;height:6px;border-radius:6px;background:#e4d9d2;}

  .topbar{
    display:flex;align-items:center;justify-content:space-between;
    padding:6px 18px 12px;flex:none;
  }
  .topbar .menu{font-size:18px;color:var(--plum);}
  .topbar .brand{display:flex;align-items:center;gap:6px;font-family:'Cormorant Garamond',serif;font-weight:700;font-size:17px;color:var(--plum);}
  .topbar .brand .g{color:var(--marigold);}
  .topbar .right{display:flex;align-items:center;gap:8px;}
  .assist-dot{width:22px;height:22px;border-radius:50%;background:conic-gradient(from 90deg,var(--marigold),var(--lilac),var(--marigold));}
  .avatar{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,var(--lilac),var(--marigold));}

  .scroll{flex:1;overflow-y:auto;padding-bottom:78px;}
  .scroll::-webkit-scrollbar{display:none;}

  .season-banner{
    display:flex;align-items:center;justify-content:space-between;gap:10px;
    background:var(--marigold-soft);border-top:1px solid var(--line);border-bottom:1px solid var(--line);
    padding:8px 18px;font-size:11.5px;color:var(--plum);flex:none;
  }
  .season-banner .now{font-weight:600;display:flex;align-items:center;gap:5px;}
  .season-banner .next{color:var(--ink-dim);}

  .band{position:relative;background:linear-gradient(180deg,var(--blush-1),var(--blush-2));padding:20px 18px 26px;overflow:hidden;}
  .band-icon{
    position:absolute;top:16px;right:16px;width:46px;height:46px;border-radius:50%;
    background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.18);
    display:flex;align-items:center;justify-content:center;font-size:20px;
    backdrop-filter:blur(2px);
  }
  .band .date{font-size:11.5px;color:var(--band-text-dim);margin-bottom:2px;padding-right:54px;}
  .band h1{font-size:24px;margin-bottom:10px;line-height:1.15;color:var(--band-text);padding-right:54px;}
  .band .quote{font-style:italic;font-family:'Cormorant Garamond',serif;font-size:15px;border-left:2px solid var(--marigold);padding-left:10px;margin-bottom:16px;color:var(--band-text);}
  .chip-list{display:flex;flex-direction:column;gap:8px;margin-bottom:12px;}
  .chip-list .row{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--band-text-dim);}
  .chip-list .g{width:26px;height:26px;border-radius:8px;background:var(--marigold);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;flex:none;}
  .chip-list b{font-weight:600;color:var(--band-text);}
  .link-arrow{font-size:12.5px;color:var(--marigold);font-weight:600;}

  .section{
    background:var(--paper);
    border:1px solid var(--line);
    border-radius:16px;
    margin:12px 16px;
    padding:18px;
    box-shadow:0 2px 10px rgba(58,31,56,0.06);
  }
  .section h2{font-size:19px;margin-bottom:6px;border-left:3px solid var(--marigold);padding-left:11px;}
  .section p{font-size:13px;line-height:1.6;color:var(--ink-dim);margin:0;}
  .section .subtitle{font-size:12px;color:var(--ink-dim);margin-top:8px;}

  .buttons{display:flex;gap:8px;margin-top:12px;}
  .btn{
    flex:1;padding:9px 12px;border:none;border-radius:8px;
    font-size:12px;font-weight:600;cursor:pointer;
    background:var(--marigold);color:#fff;
    transition:all 0.2s;
  }
  .btn:hover{opacity:0.9;}
  .btn-secondary{background:var(--lilac);}
  .btn-outline{background:transparent;border:1px solid var(--marigold);color:var(--marigold);}

  .overlay{
    position:fixed;top:0;left:0;right:0;bottom:0;
    background:rgba(0,0,0,0.5);z-index:1000;
    display:none;align-items:center;justify-content:center;
  }
  .overlay.active{display:flex;}
  .modal{
    background:var(--paper);border-radius:20px;padding:24px;
    width:90%;max-width:350px;box-shadow:0 10px 40px rgba(0,0,0,0.3);
    max-height:90vh;overflow-y:auto;
  }
  .modal h3{font-size:18px;margin-bottom:12px;}
  .modal-close{position:absolute;top:12px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;}
  .input-group{margin-bottom:12px;}
  .input-group label{display:block;font-size:12px;font-weight:600;color:var(--plum);margin-bottom:4px;}
  .input-group input,.input-group select{
    width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;
    font-size:13px;font-family:inherit;
  }

  .cart-item{
    display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);
  }
  .cart-item:last-child{border:none;}
  .cart-item .emoji{font-size:18px;}
  .cart-item .text{flex:1;}
  .cart-item .price{font-weight:600;color:var(--marigold);}

  #carta-visual-container{
    margin-top:12px;text-align:center;
  }
  #carta-visual-container svg{
    max-width:100%;height:auto;
    display:inline-block;
  }

  .section-title-bar{
    display:flex;align-items:center;justify-content:space-between;
    padding:12px 16px;background:var(--marigold-soft);
    border-bottom:1px solid var(--line);
  }
  .section-title-bar h2{
    margin:0;font-size:16px;border:none;padding:0;
  }

  .carousel{
    display:flex;gap:8px;overflow-x:auto;padding:12px 16px;
  }
  .carousel::-webkit-scrollbar{height:4px;}
  .carousel-item{
    flex-shrink:0;width:140px;padding:12px;
    background:var(--marigold-soft);border-radius:8px;
    text-align:center;border:1px solid var(--line);
  }
  .carousel-item .emoji{font-size:24px;display:block;margin-bottom:4px;}
  .carousel-item .label{font-size:11px;font-weight:600;color:var(--plum);}
</style>
</head>
<body>

<div class="page">
  <div class="phone">
    <div class="screen">
      <div class="notch">
        <div class="pill"></div>
      </div>

      <div class="topbar">
        <div class="menu">☰</div>
        <div class="brand">Sam <span class="g">✨</span></div>
        <div class="right">
          <div class="assist-dot"></div>
          <div class="avatar"></div>
        </div>
      </div>

      <div class="season-banner">
        <div class="now">🌍 Ahora</div>
        <div class="next">Próximas fases: 🌙</div>
      </div>

      <div class="scroll" id="main-scroll">

        <!-- BAND SECTION -->
        <div class="band">
          <div class="band-icon" id="band-icon">✨</div>
          <div class="date" id="band-date">Domingo 14 de septiembre 2026</div>
          <h1 id="band-greeting">Hola Samantha ✨</h1>
          <div class="quote" id="band-quote">"Tu destino está escrito en las estrellas"</div>

          <div class="chip-list">
            <div class="row">
              <div class="g">☀</div>
              <div>Sol: <b id="sol-signo">Virgo</b> <span class="subtitle">en tu casa X</span></div>
            </div>
            <div class="row">
              <div class="g">↑</div>
              <div>Ascendente: <b id="asc-signo">Libra</b> <span class="subtitle">tu energía externa</span></div>
            </div>
            <div class="row">
              <div class="g">🌙</div>
              <div>Luna: <b id="luna-signo">Cáncer</b> <span class="subtitle">tus emociones</span></div>
            </div>
          </div>
        </div>

        <!-- TU CARTA NATAL -->
        <div class="section">
          <h2>📊 Tu carta natal (real)</h2>
          <p>Calcula tu carta natal y visualiza tu rueda astral personalizada.</p>
          <div class="buttons">
            <button class="btn" id="btn-calcular">Calcular mi carta</button>
            <button class="btn btn-secondary" id="btn-ver-rueda" style="display:none;">Ver mi carta 🔮</button>
          </div>
          <div id="carta-visual-container"></div>
        </div>

        <!-- TUS CARTAS -->
        <div class="section">
          <h2>🔮 Tus cartas guardadas</h2>
          <div class="carousel" id="cartas-carousel">
            <div class="carousel-item">
              <div class="emoji">☀</div>
              <div class="label">Carta #1</div>
            </div>
            <div class="carousel-item">
              <div class="emoji">🌙</div>
              <div class="label">Carta #2</div>
            </div>
          </div>
        </div>

        <!-- HORÓSCOPO -->
        <div class="section">
          <h2>♈ Horóscopo diario</h2>
          <p id="horoscopo-text">Hoy es un día perfecto para nuevas iniciativas. Mercurio en Virgo favorece la comunicación clara.</p>
          <div class="subtitle" id="horoscopo-fecha">Actualizado hoy</div>
        </div>

        <!-- TRÁNSITOS -->
        <div class="section">
          <h2>🪐 Tránsitos de hoy</h2>
          <p id="transitos-text">La Luna se mueve por Géminis. Mercurio está retrógrado hasta el 30 de septiembre.</p>
          <button class="btn btn-outline" id="btn-transitos" style="margin-top:12px;">Ver detalles →</button>
        </div>

        <!-- SINASTRÍA -->
        <div class="section">
          <h2>💕 Sinastría (compatibilidad)</h2>
          <p id="sinstria-text">Compara tu carta natal con la de otra persona para descubrir tu compatibilidad astral.</p>
          <button class="btn btn-outline" id="btn-sinstria" style="margin-top:12px;">Calcular compatibilidad →</button>
        </div>

        <!-- CONSEJO DIARIO (TAROT) -->
        <div class="section">
          <h2>🃏 Consejo diario (Tarot)</h2>
          <div id="tarot-container">
            <div style="font-size:36px;text-align:center;margin:12px 0;">🃏</div>
            <p id="tarot-text">Cargando tu carta del día...</p>
          </div>
          <button class="btn btn-outline" id="btn-tarot-nuevo" style="margin-top:12px;">Nueva tirada →</button>
        </div>

        <!-- CICLO LUNAR -->
        <div class="section">
          <h2>🌙 Ciclo lunar</h2>
          <p id="lunar-text">Luna Creciente al 65%. Próxima Luna Llena en 8 días.</p>
          <button class="btn btn-outline" id="btn-lunar" style="margin-top:12px;">Ver fases →</button>
        </div>

        <!-- MEJORES DÍAS -->
        <div class="section">
          <h2>📅 Mejores días esta semana</h2>
          <p id="mejores-dias-text">Lunes y Miércoles: días favorables. Evita viernes para decisiones importantes.</p>
        </div>

        <!-- ASTROCARTOGRAFÍA -->
        <div class="section">
          <h2>🗺️ Astrocartografía</h2>
          <p id="astrocarto-text">Descubre los lugares del mundo donde tu energía es más potente.</p>
          <button class="btn btn-outline" id="btn-astrocarto" style="margin-top:12px;">Explorar ubicaciones →</button>
        </div>

        <!-- ECLIPSES -->
        <div class="section">
          <h2>☄️ Próximos eclipses</h2>
          <p id="eclipses-text">Cargando información de eclipses...</p>
          <button class="btn btn-outline" id="btn-eclipses" style="margin-top:12px;">Ver todos →</button>
        </div>

        <!-- MÁS HERRAMIENTAS -->
        <div class="section">
          <h2>🔧 Más herramientas</h2>
          <p>Accede a calculadoras avanzadas, progresiones y tránsitos personalizados.</p>
          <button class="btn btn-outline" style="margin-top:12px;">Explorar herramientas →</button>
        </div>

      </div>
    </div>
  </div>
</div>

<!-- OVERLAY: Login -->
<div class="overlay" id="overlay-login">
  <div class="modal">
    <h3>Inicia sesión</h3>
    <div class="input-group">
      <label>Email</label>
      <input type="email" id="login-email" placeholder="tu@email.com">
    </div>
    <div class="input-group">
      <label>Contraseña</label>
      <input type="password" id="login-password" placeholder="Tu contraseña">
    </div>
    <button class="btn" id="btn-login-submit" style="width:100%;margin-top:12px;">Entrar</button>
    <button class="btn btn-outline" id="btn-ir-registro" style="width:100%;margin-top:8px;">¿No tienes cuenta? Regístrate</button>
  </div>
</div>

<!-- OVERLAY: Registro -->
<div class="overlay" id="overlay-registro">
  <div class="modal">
    <h3>Crea tu cuenta</h3>
    <div class="input-group">
      <label>Nombre completo</label>
      <input type="text" id="registro-nombre" placeholder="Tu nombre">
    </div>
    <div class="input-group">
      <label>Email</label>
      <input type="email" id="registro-email" placeholder="tu@email.com">
    </div>
    <div class="input-group">
      <label>Contraseña</label>
      <input type="password" id="registro-password" placeholder="Crea una contraseña">
    </div>
    <button class="btn" id="btn-registro-submit" style="width:100%;margin-top:12px;">Registrarme</button>
    <button class="btn btn-outline" id="btn-ir-login" style="width:100%;margin-top:8px;">¿Ya tienes cuenta? Inicia sesión</button>
  </div>
</div>

<!-- OVERLAY: Perfil -->
<div class="overlay" id="overlay-perfil">
  <div class="modal">
    <h3>Tu perfil</h3>
    <div class="input-group">
      <label>Nombre</label>
      <input type="text" id="perfil-nombre" placeholder="Tu nombre">
    </div>
    <div class="input-group">
      <label>Fecha de nacimiento (YYYY-MM-DD)</label>
      <input type="date" id="perfil-fecha">
    </div>
    <div class="input-group">
      <label>Hora de nacimiento (HH:MM)</label>
      <input type="time" id="perfil-hora">
    </div>
    <div class="input-group">
      <label>Lugar de nacimiento</label>
      <input type="text" id="perfil-lugar" placeholder="Ciudad, País">
    </div>
    <div class="input-group">
      <label>Latitud</label>
      <input type="number" id="perfil-lat" placeholder="Ej: 19.4326" step="0.0001">
    </div>
    <div class="input-group">
      <label>Longitud</label>
      <input type="number" id="perfil-lon" placeholder="Ej: -99.1332" step="0.0001">
    </div>
    <button class="btn" id="btn-perfil-guardar" style="width:100%;margin-top:12px;">Guardar perfil</button>
  </div>
</div>

<script>
const API_URL = 'https://saaalquimiaastral.onrender.com';

// Session object
const SESION = {
  token: localStorage.getItem('saa_token'),
  nombre: localStorage.getItem('saa_nombre')
};

// ============ UTILITY FUNCTIONS ============

function mostrarPantalla(nombreOverlay) {
  document.querySelectorAll('.overlay').forEach(el => el.classList.remove('active'));
  if (nombreOverlay) {
    const overlay = document.getElementById(`overlay-${nombreOverlay}`);
    if (overlay) overlay.classList.add('active');
  }
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return { emoji: '🌅', text: 'Buenos días' };
  if (hour < 18) return { emoji: '☀️', text: 'Buenas tardes' };
  return { emoji: '🌙', text: 'Buenas noches' };
}

async function fetchAPI(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json'
    }
  };

  if (SESION.token) {
    options.headers.Authorization = `Bearer ${SESION.token}`;
  }

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_URL}${endpoint}`, options);
  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// ============ AUTH FUNCTIONS ============

async function accionLogin() {
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  if (!email || !password) {
    alert('Por favor completa email y contraseña');
    return;
  }

  try {
    const data = await fetchAPI('/auth/login', 'POST', { email, password });
    SESION.token = data.token;
    SESION.nombre = data.user.email;
    localStorage.setItem('saa_token', data.token);
    localStorage.setItem('saa_nombre', data.user.email);
    mostrarPantalla(null);
    revisarPerfilYArrancar();
  } catch (err) {
    alert('Error al iniciar sesión: ' + err.message);
  }
}

async function accionRegistro() {
  const nombre = document.getElementById('registro-nombre').value;
  const email = document.getElementById('registro-email').value;
  const password = document.getElementById('registro-password').value;

  if (!nombre || !email || !password) {
    alert('Por favor completa todos los campos');
    return;
  }

  try {
    const data = await fetchAPI('/auth/registro', 'POST', { email, password, nombre });
    SESION.token = data.token;
    SESION.nombre = data.user.nombre;
    localStorage.setItem('saa_token', data.token);
    localStorage.setItem('saa_nombre', data.user.nombre);
    mostrarPantalla(null);
    revisarPerfilYArrancar();
  } catch (err) {
    alert('Error al registrarse: ' + err.message);
  }
}

async function accionGuardarPerfil() {
  const nombre = document.getElementById('perfil-nombre').value;
  const fecha = document.getElementById('perfil-fecha').value;
  const hora = document.getElementById('perfil-hora').value;
  const lugar = document.getElementById('perfil-lugar').value;
  const lat = parseFloat(document.getElementById('perfil-lat').value);
  const lon = parseFloat(document.getElementById('perfil-lon').value);

  if (!nombre || !fecha || !hora || !lugar || !lat || !lon) {
    alert('Por favor completa todos los campos');
    return;
  }

  try {
    await fetchAPI('/perfil', 'POST', { nombre, fecha_nac: fecha, hora_nac: hora, lugar_nac: lugar, lat, lon });
    alert('¡Perfil guardado! 🎉');
    mostrarPantalla(null);
  } catch (err) {
    alert('Error al guardar perfil: ' + err.message);
  }
}

// ============ ASTROLOGICAL FUNCTIONS ============

async function calcularCartaReal() {
  // Get profile data first
  try {
    const perfil = await fetchAPI('/perfil', 'GET');
    if (!perfil.fecha_nac || !perfil.hora_nac) {
      alert('Completa tu perfil primero con fecha, hora y lugar de nacimiento');
      mostrarPantalla('perfil');
      return;
    }

    // Calculate natal chart
    const cartaData = await fetchAPI('/carta-natal', 'POST', {
      fecha: perfil.fecha_nac,
      hora: perfil.hora_nac,
      lugar: perfil.lugar_nac,
      lat: perfil.lat,
      lon: perfil.lon
    });

    alert('¡Carta natal calculada! 🌟');

    // Show the "Ver carta" button
    document.getElementById('btn-ver-rueda').style.display = 'block';

    // Update band with new data
    if (cartaData.data?.planets) {
      const planets = cartaData.data.planets;
      const sunSign = planets.sun?.sign || 'Virgo';
      const ascSign = planets.ascendant?.sign || 'Libra';
      const moonSign = planets.moon?.sign || 'Cáncer';

      document.getElementById('sol-signo').textContent = sunSign;
      document.getElementById('asc-signo').textContent = ascSign;
      document.getElementById('luna-signo').textContent = moonSign;
    }

  } catch (err) {
    alert('Error al calcular carta: ' + err.message);
  }
}

async function verCartaVisual() {
  try {
    const perfil = await fetchAPI('/perfil', 'GET');
    if (!perfil.fecha_nac || !perfil.hora_nac) {
      alert('Datos incompletos');
      return;
    }

    const response = await fetchAPI('/carta-visual', 'POST', {
      fecha: perfil.fecha_nac,
      hora: perfil.hora_nac,
      lugar: perfil.lugar_nac,
      lat: perfil.lat,
      lon: perfil.lon
    });

    const container = document.getElementById('carta-visual-container');
    container.innerHTML = response.svg_content;
  } catch (err) {
    alert('Error al mostrar carta: ' + err.message);
  }
}

async function cargarLunaActual() {
  try {
    const lunaData = await fetchAPI('/luna', 'POST', {});
    const fase = lunaData.fase_actual;
    const porcentaje = Math.round(lunaData.porcentaje);
    document.getElementById('lunar-text').textContent = `${fase} al ${porcentaje}%. Próxima Luna Llena en 8 días.`;
  } catch (err) {
    console.error('Error cargando luna:', err);
  }
}

async function cargarTransitos() {
  try {
    const tData = await fetchAPI('/transitos', 'POST', {});
    document.getElementById('transitos-text').textContent = `Luna en ${tData.luna_posicion?.sign || 'Géminis'}. Mercurio está activo hoy.`;
  } catch (err) {
    console.error('Error cargando tránsitos:', err);
  }
}

async function cargarTarot() {
  try {
    const tarotData = await fetchAPI('/tarot', 'POST', { tipo: 'diario' });
    const cartas = tarotData.cartas;
    let cartasText = '';
    if (Array.isArray(cartas) && cartas.length > 0) {
      cartasText = cartas.map(c => `${c.name} (${c.meaning})`).join(' • ');
    }
    document.getElementById('tarot-text').textContent = cartasText || 'Tu carta del día: La Rueda de la Fortuna 🔄';
  } catch (err) {
    console.error('Error cargando tarot:', err);
  }
}

async function cargarEclipses() {
  try {
    const eclipsesData = await fetchAPI('/eclipses', 'POST', { cantidad: 3 });
    const eclipses = eclipsesData.proximos_eclipses;
    let eclipsesText = '';
    if (Array.isArray(eclipses) && eclipses.length > 0) {
      eclipsesText = eclipses.map(e => `${e.tipo === 'solar' ? '☀️' : '🌙'} ${e.fecha} en ${e.signo}`).join('\n');
    }
    document.getElementById('eclipses-text').textContent = eclipsesText || 'Próximos eclipses cargándose...';
  } catch (err) {
    console.error('Error cargando eclipses:', err);
  }
}

// ============ INITIALIZATION ============

function revisarPerfilYArrancar() {
  if (!SESION.token) {
    mostrarPantalla('login');
    return;
  }

  // Update greeting
  const greeting = getGreeting();
  document.getElementById('band-icon').textContent = greeting.emoji;
  document.getElementById('band-greeting').textContent = `${greeting.text} ${SESION.nombre || '✨'}`;

  // Load all astrological data
  cargarLunaActual();
  cargarTransitos();
  cargarTarot();
  cargarEclipses();
}

// ============ EVENT LISTENERS ============

document.getElementById('btn-calcular').addEventListener('click', calcularCartaReal);
document.getElementById('btn-ver-rueda').addEventListener('click', verCartaVisual);

document.getElementById('btn-login-submit').addEventListener('click', accionLogin);
document.getElementById('btn-ir-registro').addEventListener('click', () => mostrarPantalla('registro'));

document.getElementById('btn-registro-submit').addEventListener('click', accionRegistro);
document.getElementById('btn-ir-login').addEventListener('click', () => mostrarPantalla('login'));

document.getElementById('btn-perfil-guardar').addEventListener('click', accionGuardarPerfil);

document.getElementById('btn-transitos').addEventListener('click', () => cargarTransitos());
document.getElementById('btn-tarot-nuevo').addEventListener('click', () => cargarTarot());
document.getElementById('btn-lunar').addEventListener('click', () => cargarLunaActual());
document.getElementById('btn-eclipses').addEventListener('click', () => cargarEclipses());

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  revisarPerfilYArrancar();
});
</script>

</body>
</html>
