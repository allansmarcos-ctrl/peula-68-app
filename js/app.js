'use strict';
/* ===== As Portas de Jerusalém: lógica =====
   Um arquivo só, sem framework. Lê os JSON de conteudo/, controla as telas,
   o mapa Leaflet com a imagem georreferenciada e a verificação de caminho.
   Princípio-mestre: nunca travar. GPS que falha é ignorado, não vira erro. */

// ---------- constantes ----------
const CHAVE_ESTADO = 'peula68';
const INTERVALO_AUTO_MS = 10 * 60 * 1000;      // verificação automática: 10 min
const COOLDOWN_AVISO_AUTO_MS = 5 * 60 * 1000;  // não repetir aviso automático antes disso
const PASSO_MOCK_M = 12;                       // "andar" do GPS simulado no painel debug

// ---------- estado global ----------
let TEXTOS = null, CONFIG = null, ROTAS = null;
let rotaAtiva = null;
let etapaAtual = 1;            // 1-based; (total + 1) significa rota concluída
let posAtual = null;           // {lat, lng, acc, fonte}
let mock = null;               // {lat, lng} quando GPS simulado por ?mock=
let mapa = null, overlay = null, marcadorUser = null, circuloAcc = null, marcadorInicio = null;
let cantosEdit = null;         // cópia editável dos cantos (modo calibração)
let camadasDebug = [];
let modoDebug = false;
let precisaVerificarEntrada = false;
let ultimoAvisoAutoTs = 0;
let toastTimer = null;
let watchId = null;

const $ = (id) => document.getElementById(id);

// ---------- estado no localStorage (nunca travar se indisponível) ----------
function lerEstado() {
  try { return JSON.parse(localStorage.getItem(CHAVE_ESTADO)) || null; }
  catch (e) { return null; }
}
function salvarEstado() {
  try { localStorage.setItem(CHAVE_ESTADO, JSON.stringify({ rota: rotaAtiva.id, etapa: etapaAtual })); }
  catch (e) { /* modo privado sem storage: o jogo segue, só não sobrevive a reload */ }
}
function limparEstado() {
  try { localStorage.removeItem(CHAVE_ESTADO); } catch (e) {}
}

// ---------- util ----------
function normalizar(s) {
  // maiúsculas, sem acentos e sem espaços: "o fel" e "OFEL" valem o mesmo
  return (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '');
}

function toast(msg, ms) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('oculto');
  requestAnimationFrame(() => el.classList.add('visivel'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visivel'), ms || 4200);
}

function mostrarTela(nome) {
  $('aviso').classList.add('oculto'); // aviso é contextual: trocou de tela, morreu
  ['portao', 'mapa', 'estacao', 'final'].forEach(t => $('tela-' + t).classList.toggle('ativa', t === nome));
  if (nome === 'mapa' && mapa) setTimeout(() => mapa.invalidateSize(), 60);
}

// Distância (em metros) de uma posição à polilinha do corredor.
// Projeção equiretangular local: mais que suficiente para dezenas de metros.
function distanciaAoCorredorM(pos, corredor) {
  if (!corredor || !corredor.length) return Infinity;
  const kx = 111320 * Math.cos(pos.lat * Math.PI / 180); // metros por grau de longitude
  const ky = 110574;                                     // metros por grau de latitude
  const pts = corredor.map(c => ({ x: (c[1] - pos.lng) * kx, y: (c[0] - pos.lat) * ky }));
  if (pts.length === 1) return Math.hypot(pts[0].x, pts[0].y);
  let min = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const A = pts[i], B = pts[i + 1];
    const vx = B.x - A.x, vy = B.y - A.y;
    const l2 = vx * vx + vy * vy;
    let t = l2 ? -(A.x * vx + A.y * vy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    min = Math.min(min, Math.hypot(A.x + t * vx, A.y + t * vy));
  }
  return min;
}

// ---------- carga do conteúdo ----------
async function carregarJSON(caminho) {
  // no-cache: revalida com o servidor; sem isso o browser pode servir JSON
  // velho por cache heurístico e uma edição pós-scouting demora a chegar
  const r = await fetch(caminho, { cache: 'no-cache' });
  if (!r.ok) throw new Error('Falha ao carregar ' + caminho);
  return r.json();
}

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.has('reset')) limparEstado();
  if (params.has('mock')) {
    const m = (params.get('mock') || '').split(',').map(Number);
    if (m.length === 2 && m.every(isFinite)) mock = { lat: m[0], lng: m[1] };
  }

  try {
    [TEXTOS, CONFIG, ROTAS] = await Promise.all([
      carregarJSON('conteudo/textos.json'),
      carregarJSON('conteudo/config-mapa.json'),
      carregarJSON('conteudo/rotas.json'),
    ]);
  } catch (e) {
    $('erro-portao').textContent = 'Não deu para carregar o jogo. Conectem à internet uma vez e recarreguem a página.';
    return;
  }

  aplicarTextos();
  registrarSW();
  ligarEventos();

  // retomar jogo salvo, se houver
  const salvo = lerEstado();
  if (salvo) {
    const rota = ROTAS.rotas.find(r => r.id === salvo.rota);
    if (rota && salvo.etapa >= 1 && salvo.etapa <= rota.etapas.length + 1) {
      entrarNoJogo(rota, salvo.etapa);
      if (params.has('debug')) ativarDebug();
      return;
    }
    limparEstado();
  }
  mostrarTela('portao');
  if (params.has('debug')) modoDebug = true; // ativa de verdade quando entrar no jogo
}

function aplicarTextos() {
  document.title = TEXTOS.titulo;
  document.querySelectorAll('[data-txt]').forEach(el => {
    const t = TEXTOS[el.getAttribute('data-txt')];
    if (t) el.textContent = t;
  });
}

function registrarSW() {
  if (!('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  // em localhost o cache atrapalha o desenvolvimento; só registra com ?sw=1
  if (local && !new URLSearchParams(location.search).has('sw')) return;
  if (location.protocol === 'https:' || local) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ---------- eventos ----------
function ligarEventos() {
  $('form-portao').addEventListener('submit', (e) => {
    e.preventDefault();
    const senha = normalizar($('senha-portao').value);
    const rota = ROTAS.rotas.find(r => normalizar(r.senha_entrada) === senha);
    if (!rota) {
      $('erro-portao').textContent = TEXTOS.senha_errada;
      $('senha-portao').focus();
      $('senha-portao').select();
      return;
    }
    $('erro-portao').textContent = '';
    etapaAtual = 1;
    rotaAtiva = rota;
    salvarEstado();
    entrarNoJogo(rota, 1, true);
  });

  $('botao-verificar').addEventListener('click', () => verificar('botao'));
  $('botao-missao').addEventListener('click', abrirEstacao);
  $('botao-voltar').addEventListener('click', () => mostrarTela('mapa'));
  $('botao-centrar').addEventListener('click', () => {
    if (posAtual && mapa) mapa.setView([posAtual.lat, posAtual.lng], Math.max(mapa.getZoom(), CONFIG.zoom.inicial));
    else toast(TEXTOS.sem_gps);
  });

  $('form-estacao').addEventListener('submit', (e) => {
    e.preventDefault();
    selarEtapa();
  });

  $('aviso-fechar').addEventListener('click', () => $('aviso').classList.add('oculto'));

  // 7 toques no cabeçalho do mapa abrem o painel de calibração
  let taps = 0, tapTimer = null;
  $('header-mapa').addEventListener('click', () => {
    taps++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { taps = 0; }, 3000);
    if (taps >= 7) { taps = 0; ativarDebug(); }
  });

  // verificação automática a cada 10 minutos (roda com a tela ligada; é advisory)
  setInterval(() => { if (rotaAtiva && etapaAtual <= rotaAtiva.etapas.length) verificar('auto'); }, INTERVALO_AUTO_MS);
}

// ---------- fluxo do jogo ----------
function entrarNoJogo(rota, etapa, novoJogo) {
  rotaAtiva = rota;
  etapaAtual = etapa;
  if (!mapa) montarMapa();
  atualizarHeader();
  iniciarGeolocalizacao();
  if (modoDebug) ativarDebug();
  if (etapa > rota.etapas.length) { mostrarFinal(); return; }
  if (novoJogo) {
    // primeira entrada: a história da etapa 1 recebe o grupo; o mapa vem depois
    abrirEstacao();
    toast(TEXTOS.portao_abriu);
  } else {
    mostrarTela('mapa');
  }
  precisaVerificarEntrada = true;
  verificar('entrada');
}

function atualizarHeader() {
  const total = rotaAtiva.etapas.length;
  const rotulo = etapaAtual > total
    ? rotaAtiva.seita
    : rotaAtiva.seita + ' · ' + TEXTOS.etapa_rotulo + ' ' + etapaAtual + ' ' + TEXTOS.de + ' ' + total;
  $('header-texto').textContent = rotulo;
  $('selo-seita').style.background = rotaAtiva.cor || '#b8860b';
}

function etapaObj() {
  return rotaAtiva ? rotaAtiva.etapas[etapaAtual - 1] : null;
}

function abrirEstacao() {
  const et = etapaObj();
  if (!et) { mostrarFinal(); return; }
  $('estacao-cab').textContent = rotaAtiva.seita + ' · ' + TEXTOS.etapa_rotulo + ' ' + etapaAtual + ' ' + TEXTOS.de + ' ' + rotaAtiva.etapas.length;
  $('estacao-titulo').textContent = et.titulo || TEXTOS.etapa_rotulo + ' ' + etapaAtual;
  $('estacao-texto').textContent = et.texto_diwan || '';
  $('estacao-missao').textContent = et.missao || '';
  const fotosEl = $('estacao-fotos');
  fotosEl.innerHTML = '';
  (et.fotos || []).forEach((src) => {
    const im = document.createElement('img');
    im.src = src;
    im.alt = '';
    im.loading = 'lazy';
    im.onerror = () => im.remove(); // foto faltando não vira ícone quebrado
    fotosEl.appendChild(im);
  });
  $('senha-estacao').value = '';
  $('erro-estacao').textContent = '';
  mostrarTela('estacao');
}

function selarEtapa() {
  const et = etapaObj();
  if (!et) return;
  const tentativa = normalizar($('senha-estacao').value);
  if (tentativa !== normalizar(et.senha_desbloqueio)) {
    $('erro-estacao').textContent = TEXTOS.senha_desbloqueio_errada;
    $('senha-estacao').focus();
    $('senha-estacao').select();
    return;
  }
  etapaAtual++;
  salvarEstado();
  if (etapaAtual > rotaAtiva.etapas.length) { mostrarFinal(); return; }
  atualizarHeader();
  toast(TEXTOS.etapa_avancou);
  mostrarTela('mapa');
  precisaVerificarEntrada = true;
  verificar('entrada');
}

function mostrarFinal() {
  $('final-seita').textContent = rotaAtiva.seita;
  $('final-fragmento').textContent = rotaAtiva.fragmento_final || '';
  $('final-convergencia').textContent = TEXTOS.convergencia;
  mostrarTela('final');
}

// ---------- geolocalização ----------
function iniciarGeolocalizacao() {
  if (mock) { atualizarPosicao(mock.lat, mock.lng, 10, 'mock'); return; }
  if (!('geolocation' in navigator) || watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(
    (p) => atualizarPosicao(p.coords.latitude, p.coords.longitude, p.coords.accuracy || 0, 'gps'),
    () => setBadgeGps('sem'),   // erro de GPS nunca vira tela de erro
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function atualizarPosicao(lat, lng, acc, fonte) {
  posAtual = { lat, lng, acc, fonte };
  setBadgeGps(fonte === 'mock' ? 'mock' : 'ok');
  if (mapa) {
    const ll = [lat, lng];
    if (!marcadorUser) {
      const icone = L.divIcon({
        className: '',
        html: '<div class="tocha"><div class="chama"></div><div class="chama chama2"></div><div class="cabo"></div></div>',
        iconSize: [34, 48],
        iconAnchor: [17, 46],
      });
      marcadorUser = L.marker(ll, { icon: icone, interactive: false, zIndexOffset: 900 }).addTo(mapa);
      circuloAcc = L.circle(ll, {
        radius: Math.max(acc, 8),
        color: '#6b4a2a', weight: 1, dashArray: '4 6', fillColor: '#b8860b', fillOpacity: 0.06, interactive: false,
      }).addTo(mapa);
      mapa.setView(ll, CONFIG.zoom.inicial);
    } else {
      marcadorUser.setLatLng(ll);
      circuloAcc.setLatLng(ll);
      circuloAcc.setRadius(Math.max(acc, 8));
    }
  }
  if (precisaVerificarEntrada) { precisaVerificarEntrada = false; verificar('entrada'); }
  atualizarPainelDebug();
}

function setBadgeGps(estado) {
  const b = $('badge-gps');
  b.className = estado;
  b.title = estado === 'mock' ? TEXTOS.gps_simulado : '';
}

// ---------- verificação de caminho (advisory: só avisa, nunca bloqueia) ----------
function verificar(origem) {
  const et = etapaObj();
  if (!et) return;

  if (!posAtual) {
    if (origem !== 'botao') return; // silêncio nas checagens automáticas sem posição
    // tenta uma leitura única antes de desistir (também dispara o pedido de permissão)
    if ('geolocation' in navigator && !mock) {
      toast(TEXTOS.verificando, 8000);
      navigator.geolocation.getCurrentPosition(
        (p) => { atualizarPosicao(p.coords.latitude, p.coords.longitude, p.coords.accuracy || 0, 'gps'); avaliar(origem); },
        () => toast(TEXTOS.sem_gps),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      );
    } else {
      toast(TEXTOS.sem_gps);
    }
    return;
  }
  avaliar(origem);
}

function avaliar(origem) {
  const et = etapaObj();
  if (!et || !posAtual) return;
  const dist = distanciaAoCorredorM(posAtual, et.corredor);
  // tolerância extra proporcional à imprecisão do GPS (limitada a 30 m)
  const folga = Math.min(posAtual.acc || 0, 30);
  const dentro = dist <= (et.raio_m || 50) + folga;

  if (dentro) {
    if (origem === 'botao') toast(TEXTOS.no_caminho);
  } else {
    const agora = Date.now();
    if (origem === 'auto' && agora - ultimoAvisoAutoTs < COOLDOWN_AVISO_AUTO_MS) return;
    if (origem === 'auto') ultimoAvisoAutoTs = agora;
    // aviso e toast não convivem: o aviso é a voz mais alta
    clearTimeout(toastTimer);
    $('toast').classList.remove('visivel');
    $('aviso-texto').textContent = TEXTOS.fora_do_caminho;
    $('aviso').classList.remove('oculto');
    $('aviso-fechar').focus();
  }
  atualizarPainelDebug(dist);
}

// ---------- mapa ----------
function montarMapa() {
  const c = CONFIG.cantos;
  cantosEdit = { noroeste: c.noroeste.slice(), sudeste: c.sudeste.slice() };
  const bounds = L.latLngBounds(c.noroeste, c.sudeste);

  mapa = L.map('mapa', {
    zoomControl: false,
    attributionControl: false,
    minZoom: CONFIG.zoom.minimo,
    maxZoom: CONFIG.zoom.maximo,
    maxBounds: bounds.pad(0.25),
    maxBoundsViscosity: 0.8,
  });
  L.control.zoom({ position: 'topright' }).addTo(mapa);

  overlay = L.imageOverlay(CONFIG.imagem, bounds).addTo(mapa);
  mapa.setView(rotaAtiva ? rotaAtiva.ponto_inicial : bounds.getCenter(), CONFIG.zoom.inicial);

  marcadorInicio = L.circleMarker(rotaAtiva.ponto_inicial, {
    radius: 9, color: '#7a1f1f', weight: 3, fillColor: '#a32a2a', fillOpacity: 0.95,
  }).addTo(mapa).bindTooltip(TEXTOS.inicio_tooltip, { direction: 'top', offset: [0, -8] });
}

// ---------- painel de calibração (debug) ----------
function ativarDebug() {
  if (!rotaAtiva || !mapa) { modoDebug = true; return; }
  modoDebug = true;
  const p = $('painel-debug');
  if (!p.classList.contains('oculto')) return;
  p.classList.remove('oculto');
  p.innerHTML =
    '<div class="linha"><strong>CALIBRAÇÃO</strong>' +
    '<button id="dbg-mini">recolher</button>' +
    '<button id="dbg-fechar">fechar</button>' +
    '<button id="dbg-reset">reiniciar jogo</button></div>' +
    '<div class="linha"><span id="dbg-pos">posição: aguardando...</span>' +
    '<button id="dbg-copiar-pos">copiar posição</button></div>' +
    (mock
      ? '<div class="linha">andar (simulado): <button data-anda="n">▲</button><button data-anda="s">▼</button><button data-anda="o">◀</button><button data-anda="l">▶</button></div>'
      : '') +
    '<div class="linha">canto NO: <button data-nudge="no,lat,1">▲</button><button data-nudge="no,lat,-1">▼</button><button data-nudge="no,lng,-1">◀</button><button data-nudge="no,lng,1">▶</button>' +
    ' &nbsp;canto SE: <button data-nudge="se,lat,1">▲</button><button data-nudge="se,lat,-1">▼</button><button data-nudge="se,lng,-1">◀</button><button data-nudge="se,lng,1">▶</button></div>' +
    '<div class="linha"><button id="dbg-copiar">copiar cantos (config-mapa.json)</button></div>' +
    '<pre id="dbg-json"></pre>';

  desenharCamadasDebug();
  atualizarPainelDebug();
  ajustarAlturaDebug();

  $('dbg-mini').addEventListener('click', () => {
    p.classList.toggle('mini');
    $('dbg-mini').textContent = p.classList.contains('mini') ? 'expandir' : 'recolher';
    ajustarAlturaDebug();
  });
  $('dbg-copiar-pos').addEventListener('click', () => {
    if (!posAtual) { toast(TEXTOS.sem_gps); return; }
    const t = posAtual.lat.toFixed(6) + ', ' + posAtual.lng.toFixed(6);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(() => toast('Copiada: ' + t)).catch(() => toast(t, 8000));
    } else toast(t, 8000);
  });
  $('dbg-fechar').addEventListener('click', desativarDebug);
  $('dbg-reset').addEventListener('click', () => {
    if (confirm('Apagar o progresso deste celular e voltar ao portão?')) {
      limparEstado();
      location.replace(location.pathname);
    }
  });
  p.querySelectorAll('[data-anda]').forEach(b => b.addEventListener('click', () => andarMock(b.getAttribute('data-anda'))));
  p.querySelectorAll('[data-nudge]').forEach(b => b.addEventListener('click', () => {
    const [canto, eixo, sinal] = b.getAttribute('data-nudge').split(',');
    const passo = 0.00025 * Number(sinal);
    const alvo = canto === 'no' ? cantosEdit.noroeste : cantosEdit.sudeste;
    if (eixo === 'lat') alvo[0] += passo; else alvo[1] += passo;
    aplicarCantosEditados();
  }));
  $('dbg-copiar').addEventListener('click', () => {
    const json = jsonCantos();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(() => toast('Cantos copiados.')).catch(() => toast('Copie manualmente do painel.'));
    } else toast('Copie manualmente do painel.');
  });
}

function desativarDebug() {
  modoDebug = false;
  $('painel-debug').classList.add('oculto');
  camadasDebug.forEach(l => mapa.removeLayer(l));
  camadasDebug = [];
  ajustarAlturaDebug();
}

// o mapa e os botões sobem a altura do painel, para nada ficar escondido atrás dele
function ajustarAlturaDebug() {
  requestAnimationFrame(() => {
    const p = $('painel-debug');
    const alt = p.classList.contains('oculto') ? 0 : p.offsetHeight;
    document.documentElement.style.setProperty('--debug-alt', alt + 'px');
    if (mapa) setTimeout(() => mapa.invalidateSize(), 80);
  });
}

function desenharCamadasDebug() {
  camadasDebug.forEach(l => mapa.removeLayer(l));
  camadasDebug = [];
  if (!rotaAtiva) return;
  rotaAtiva.etapas.forEach((et, i) => {
    camadasDebug.push(L.polyline(et.corredor, {
      color: rotaAtiva.cor || '#b8860b', weight: 3, opacity: 0.85, dashArray: '6 8',
    }).bindTooltip('etapa ' + (i + 1)).addTo(mapa));
  });
  camadasDebug.push(L.circleMarker(rotaAtiva.ponto_final, {
    radius: 8, color: '#b8860b', weight: 3, fillColor: '#ffd257', fillOpacity: 0.9,
  }).bindTooltip('ponto final').addTo(mapa));
}

function andarMock(dir) {
  if (!mock) return;
  const dLat = PASSO_MOCK_M / 110574;
  const dLng = PASSO_MOCK_M / (111320 * Math.cos(mock.lat * Math.PI / 180));
  if (dir === 'n') mock.lat += dLat;
  if (dir === 's') mock.lat -= dLat;
  if (dir === 'l') mock.lng += dLng;
  if (dir === 'o') mock.lng -= dLng;
  atualizarPosicao(mock.lat, mock.lng, 10, 'mock');
}

function aplicarCantosEditados() {
  const bounds = L.latLngBounds(cantosEdit.noroeste, cantosEdit.sudeste);
  overlay.setBounds(bounds);
  mapa.setMaxBounds(bounds.pad(0.25));
  atualizarPainelDebug();
}

function jsonCantos() {
  const f = (n) => Number(n.toFixed(6));
  return JSON.stringify({
    noroeste: [f(cantosEdit.noroeste[0]), f(cantosEdit.noroeste[1])],
    sudeste: [f(cantosEdit.sudeste[0]), f(cantosEdit.sudeste[1])],
  }, null, 2);
}

function atualizarPainelDebug(distConhecida) {
  if (!modoDebug) return;
  const posEl = $('dbg-pos');
  if (!posEl) return;
  let linha = 'posição: aguardando...';
  if (posAtual) {
    const et = etapaObj();
    const d = distConhecida !== undefined
      ? distConhecida
      : (et ? distanciaAoCorredorM(posAtual, et.corredor) : NaN);
    linha = 'pos ' + posAtual.lat.toFixed(6) + ', ' + posAtual.lng.toFixed(6) +
      ' ±' + Math.round(posAtual.acc || 0) + 'm (' + posAtual.fonte + ')' +
      (isFinite(d) ? ' | dist ao corredor: ' + Math.round(d) + 'm (etapa ' + etapaAtual + ')' : '');
  }
  posEl.textContent = linha;
  const j = $('dbg-json');
  if (j) j.textContent = jsonCantos();
}

// ---------- início ----------
init();
