'use strict';
/* ===== As Portas de Jerusalém: lógica =====
   Um arquivo só, sem framework. Lê os JSON de conteudo/, controla as telas,
   o mapa Leaflet com a imagem georreferenciada e a verificação de caminho.
   Princípio-mestre: nunca travar. GPS que falha é ignorado, não vira erro.

   A tela de jogo é VIVA: mapa e instruções na mesma tela. O painel de baixo
   tem três abas (a carta, o caminho, a missão). A carta e as leituras avançam
   no toque (texto interativo). O caminho revela um passo por vez com tiquinho.
   Design "por pistas": o mapa não mostra a rota; os marcos só acendem quando
   o grupo pede ajuda (o rumo sob demanda, nunca a linha inteira). */

// ---------- constantes ----------
const CHAVE_ESTADO = 'peula68';
const INTERVALO_AUTO_MS = 10 * 60 * 1000;      // verificação automática: 10 min
const COOLDOWN_AVISO_AUTO_MS = 5 * 60 * 1000;  // não repetir aviso automático antes disso
const PASSO_MOCK_M = 12;                       // "andar" do GPS simulado no painel debug

// Sincronia ao vivo do grupo: todos que entram na mesma corrente compartilham uma
// "sala". Quando um avança, os outros revelam a próxima carta na consulta seguinte
// (até ~1 min). Chave pública (anon) do Supabase: feita para o navegador; a proteção
// está no banco (só a RPC escreve, e ela só deixa avançar de um em um). Sem sinal,
// tudo cai no modo manual (digita a senha e avança local): nunca trava.
const SB_URL = 'https://nwdacjcbafaizbfjoxzn.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im53ZGFjamNiYWZhaXpiZmpveHpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNDUyNTAsImV4cCI6MjA5NjgyMTI1MH0.Ko6R_GUWWrzF72lnQchVcN3kDK04dA0Enj5bACnB61k';
const SYNC_MS = 35000;                          // consulta a sala a cada 35s

// ---------- estado global ----------
let TEXTOS = null, CONFIG = null, ROTAS = null;
let rotaAtiva = null;
let etapaAtual = 1;            // 1-based; (total + 1) significa rota concluída
let posAtual = null;           // {lat, lng, acc, fonte}
let mock = null;               // {lat, lng} quando GPS simulado por ?mock=
let mapa = null, overlay = null, marcadorUser = null, circuloAcc = null, marcadorInicio = null;
let carimbos = [], marcadoresMarco = [], trilhaLayer = null;
let cantosEdit = null;         // cópia editável dos cantos (modo calibração)
let camadasDebug = [];
let modoDebug = false;
let precisaVerificarEntrada = false;
let ultimoAvisoAutoTs = 0;
let toastTimer = null;
let watchId = null;
let sala = null;               // sala de sincronia (todos da corrente compartilham)
let syncTimer = null;
let sincronizando = false;

// estado da tela viva
let abaAtual = 'carta';
let passosRevelados = 1;       // quantos passos do caminho já apareceram (ajuda progressiva)
let marcosAcesos = false;      // os marcos da etapa foram acesos (pediu ajuda)?
let fluxos = {};               // controladores de leitura fatiada, por chave

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
  // maiúsculas, sem acentos e só letras/números: "o fel", "OFEL", "325-338" e "325 338" valem o esperado
  return (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '');
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
  ['portao', 'abertura', 'jogo', 'final'].forEach(t => $('tela-' + t).classList.toggle('ativa', t === nome));
  if (nome === 'jogo' && mapa) setTimeout(() => { mapa.invalidateSize(); ajustarMapaAoPainel(); }, 60);
}

// blocos de leitura: uma string vira {voz:narrador}; objeto {voz,texto} passa direto
function blocoTexto(b) { return typeof b === 'string' ? b : (b && b.texto) || ''; }
function blocoVoz(b) { return typeof b === 'string' ? 'narrador' : (b && b.voz) || 'narrador'; }
function rotuloVoz(voz) {
  switch (voz) {
    case 'gamliel': return 'Carta de Rabban Gamliel';
    case 'bilhete': return 'Um bilhete no chão';
    case 'circulo': return 'O capitão lê em voz alta';
    case 'viajante': return TEXTOS.eco_titulo || 'Você, que veio de longe';
    default: return '';
  }
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
  const r = await fetch(caminho, { cache: 'no-cache' });
  if (!r.ok) throw new Error('Falha ao carregar ' + caminho);
  return r.json();
}

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.has('reset')) limparEstado();
  // modo solo: joga 100% local, sem entrar na sala compartilhada (teste/playtest e fallback do dia)
  window.SOLO = params.has('solo');
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

  // modo ADM: tela de coleta de coordenadas (toque no mapa marca pontos numerados)
  if (params.has('adm')) { iniciarAdm(); return; }

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

  // abertura (viajante + identidade), fatiada
  $('abertura-prosseguir').addEventListener('click', () => avancarFluxo('abertura'));
  $('abertura-pular').addEventListener('click', () => { if (fluxos.abertura) fluxos.abertura.aoFim(); });

  // painel: abas, puxador
  document.querySelectorAll('.aba-btn').forEach(b => b.addEventListener('click', () => trocarAba(b.getAttribute('data-aba'))));
  $('painel-puxador').addEventListener('click', alternarPainel);
  $('carta-prosseguir').addEventListener('click', () => avancarFluxo('carta'));
  $('caminho-mais').addEventListener('click', revelarProximoPasso);

  $('botao-centrar').addEventListener('click', () => {
    if (posAtual && mapa) mapa.flyTo([posAtual.lat, posAtual.lng], Math.max(mapa.getZoom(), CONFIG.zoom.inicial), { duration: 0.8 });
    else toast(TEXTOS.sem_gps);
  });
  $('botao-ajuda').addEventListener('click', pedirAjuda);

  $('form-senha').addEventListener('submit', (e) => { e.preventDefault(); selarEtapa(); });
  // no celular, ao abrir o teclado, rola para o botao nao ficar escondido atras dele
  $('senha-input').addEventListener('focus', () => {
    setTimeout(() => { const b = $('senha-botao'); if (b) b.scrollIntoView({ block: 'center' }); }, 320);
  });

  // final, fatiado
  $('final-prosseguir').addEventListener('click', () => avancarFluxo('final'));

  // histórico de cartas (overlay)
  $('cartas-voltar').addEventListener('click', () => $('tela-cartas').classList.add('oculto'));

  $('aviso-fechar').addEventListener('click', () => $('aviso').classList.add('oculto'));

  document.addEventListener('visibilitychange', () => { if (!document.hidden) puxarSincronia(); });

  // 7 toques no cabeçalho do mapa abrem o painel de calibração
  let taps = 0, tapTimer = null;
  $('header-mapa').addEventListener('click', () => {
    taps++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { taps = 0; }, 3000);
    if (taps >= 7) { taps = 0; ativarDebug(); }
  });

  setInterval(() => { if (rotaAtiva && !window.ADM && etapaAtual <= rotaAtiva.etapas.length) verificar('auto'); }, INTERVALO_AUTO_MS);
}

// ---------- leitura fatiada (abertura, carta, fragmento): um bloco por toque ----------
function iniciarFluxo(chave, blocos, els, opts) {
  fluxos[chave] = { blocos: blocos || [], i: 0, els, opts: opts || {}, aoFim: (opts && opts.aoFim) || function () {} };
  renderFluxoBloco(chave);
}

function renderFluxoBloco(chave) {
  const st = fluxos[chave];
  if (!st) return;
  const b = st.blocos[st.i];
  const fluxo = st.els.fluxo;
  fluxo.innerHTML = '';
  const art = document.createElement('article');
  art.className = 'bloco-leitura voz-' + blocoVoz(b);
  const rot = rotuloVoz(blocoVoz(b));
  if (rot) { const s = document.createElement('span'); s.className = 'bloco-voz'; s.textContent = rot; art.appendChild(s); }
  const p = document.createElement('p'); p.textContent = blocoTexto(b); art.appendChild(p);
  fluxo.appendChild(art);
  requestAnimationFrame(() => art.classList.add('entrou'));

  if (st.els.pontos) renderPontos(st.els.pontos, st.blocos.length, st.i);
  const ultimo = st.i >= st.blocos.length - 1;
  st.els.botao.textContent = ultimo ? (st.opts.rotuloFim || TEXTOS.prosseguir) : (st.opts.rotuloProsseguir || TEXTOS.prosseguir);
  if (st.els.pular) st.els.pular.classList.toggle('oculto', ultimo);
}

function avancarFluxo(chave) {
  const st = fluxos[chave];
  if (!st) return;
  if (st.i >= st.blocos.length - 1) { st.aoFim(); return; }
  st.i++;
  renderFluxoBloco(chave);
}

function renderPontos(container, total, atual) {
  container.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const d = document.createElement('span');
    d.className = 'ponto' + (i === atual ? ' atual' : (i < atual ? ' passado' : ''));
    container.appendChild(d);
  }
}

// ---------- fluxo do jogo ----------
function entrarNoJogo(rota, etapa, novoJogo) {
  rotaAtiva = rota;
  etapaAtual = etapa;
  if (!mapa) montarMapa();
  atualizarHeader();
  iniciarGeolocalizacao();
  iniciarSincronia();
  if (modoDebug) ativarDebug();
  if (etapa > rota.etapas.length) { mostrarFinal(); return; }
  if (novoJogo) { mostrarAbertura(); return; }
  entrarEtapa();
}

function mostrarAbertura() {
  const ab = rotaAtiva.abertura;
  if (!ab || (!ab.viajante && !ab.identidade)) { entrarEtapa(); return; } // seita sem abertura: vai direto
  const blocos = []
    .concat((ab.viajante || []).map(t => ({ voz: 'viajante', texto: t })))
    .concat((ab.identidade || []).map(t => ({ voz: 'identidade', texto: t })));
  $('abertura-rotulo').textContent = rotaAtiva.seita + ' · ' + (TEXTOS.abertura_viajante_titulo || '');
  $('abertura-prosseguir').textContent = TEXTOS.prosseguir;
  $('abertura-pular').textContent = TEXTOS.abertura_pular || 'Pular';
  iniciarFluxo('abertura', blocos, {
    fluxo: $('abertura-fluxo'), pontos: $('abertura-pontos'), botao: $('abertura-prosseguir'), pular: $('abertura-pular'),
  }, {
    rotuloProsseguir: TEXTOS.prosseguir,
    rotuloFim: TEXTOS.abertura_para_mapa || TEXTOS.prosseguir,
    aoFim: () => { entrarEtapa(); toast(TEXTOS.portao_abriu); },
  });
  mostrarTela('abertura');
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

// carrega a etapa atual na tela viva e abre na aba da carta
function entrarEtapa() {
  const et = etapaObj();
  if (!et) { mostrarFinal(); return; }
  atualizarHeader();
  passosRevelados = 1;
  marcosAcesos = false;
  limparMarcos();
  renderCarta();
  renderCaminho();
  renderMissao();
  trocarAba('carta');
  mostrarTela('jogo');
  desenharCarimbos();
  precisaVerificarEntrada = true;
  verificar('entrada');
}

function blocosDaCarta(et) {
  let bl = [];
  if (Array.isArray(et.carta)) bl = et.carta.slice();
  else if (et.texto_diwan) bl = [{ voz: 'narrador', texto: et.texto_diwan }]; // compat: seitas antigas
  // o eco do viajante fecha a carta: a voz do hoje comentando o que acabaram de ler
  if (et.eco) bl.push({ voz: 'viajante', texto: et.eco });
  return bl;
}

function renderCarta() {
  const et = etapaObj();
  $('carta-titulo').textContent = (TEXTOS.etapa_rotulo + ' ' + etapaAtual) + ' · ' + (et.titulo || '');
  const blocos = blocosDaCarta(et);
  iniciarFluxo('carta', blocos, {
    fluxo: $('carta-fluxo'), pontos: $('carta-pontos'), botao: $('carta-prosseguir'),
  }, {
    rotuloProsseguir: TEXTOS.prosseguir,
    rotuloFim: TEXTOS.abrir_caminho || 'O caminho',
    aoFim: () => trocarAba('caminho'),
  });
}

function renderCaminho() {
  const et = etapaObj();
  const ol = $('caminho-passos');
  ol.innerHTML = '';
  const dirs = et.direcoes || [];
  dirs.forEach((d, i) => {
    const li = document.createElement('li');
    li.className = 'passo' + (i < passosRevelados ? '' : ' oculto');
    li.innerHTML = '<button class="passo-tique" type="button" aria-label="Marcar passo"></button><span class="passo-txt"></span>';
    li.querySelector('.passo-txt').textContent = d;
    li.querySelector('.passo-tique').addEventListener('click', () => li.classList.toggle('feito'));
    ol.appendChild(li);
  });
  atualizarBotaoMais();

  const cont = $('caminho-fotos');
  cont.innerHTML = '';
  (et.fotos || []).forEach(src => {
    const im = document.createElement('img');
    im.src = src; im.alt = ''; im.loading = 'lazy';
    im.onerror = () => im.remove();
    cont.appendChild(im);
  });
  $('caminho-fotos-bloco').classList.toggle('oculto', !(et.fotos && et.fotos.length));
  const sum = $('caminho-fotos-bloco').querySelector('summary');
  if (sum) sum.textContent = 'Fotos do caminho (' + ((et.fotos || []).length) + ')';
}

function atualizarBotaoMais() {
  const et = etapaObj();
  const total = (et.direcoes || []).length;
  const btn = $('caminho-mais');
  if (passosRevelados >= total) {
    btn.classList.add('oculto');
  } else {
    btn.classList.remove('oculto');
    btn.textContent = TEXTOS.reler_pista ? 'Mostrar o próximo passo' : 'Próximo passo';
  }
}

function revelarProximoPasso() {
  const et = etapaObj();
  const total = (et.direcoes || []).length;
  if (passosRevelados >= total) return;
  passosRevelados++;
  const ol = $('caminho-passos');
  const li = ol.children[passosRevelados - 1];
  if (li) {
    li.classList.remove('oculto');
    requestAnimationFrame(() => li.classList.add('surgiu'));
  }
  atualizarBotaoMais();
}

function renderMissao() {
  const et = etapaObj();
  $('missao-texto').textContent = et.missao || '';
  const ehCodigo = !!et.codigo_no_local;
  $('senha-rotulo').textContent = ehCodigo ? (TEXTOS.rotulo_codigo || TEXTOS.rotulo_senha_desbloqueio) : TEXTOS.rotulo_senha_desbloqueio;
  $('senha-botao').textContent = ehCodigo ? (TEXTOS.selar_codigo || TEXTOS.botao_selar) : TEXTOS.botao_selar;
  $('senha-input').value = '';
  $('senha-input').setAttribute('inputmode', ehCodigo ? 'numeric' : 'text');
  $('senha-erro').textContent = '';
}

// ---------- abas e painel deslizante ----------
function trocarAba(nome) {
  abaAtual = nome;
  document.querySelectorAll('.aba-btn').forEach(b => b.classList.toggle('ativa', b.getAttribute('data-aba') === nome));
  ['carta', 'caminho', 'missao'].forEach(a => $('aba-' + a).classList.toggle('ativa', a === nome));
  // a carta e a missão querem espaço (leitura); o caminho quer o mapa grande
  const alto = (nome === 'carta' || nome === 'missao');
  $('painel').classList.toggle('painel-baixo', !alto);
  ajustarMapaAoPainel();
}

function alternarPainel() {
  $('painel').classList.toggle('painel-baixo');
  ajustarMapaAoPainel();
}

// o mapa termina onde o painel começa (os dois sempre visíveis)
function ajustarMapaAoPainel() {
  requestAnimationFrame(() => {
    const alt = $('painel').offsetHeight;
    document.documentElement.style.setProperty('--painel-alt', alt + 'px');
    if (mapa) setTimeout(() => mapa.invalidateSize(), 60);
  });
}

// ---------- ajuda: uma mão na direção (revela passo + acende o rumo no mapa) ----------
function pedirAjuda() {
  const et = etapaObj();
  if (!et) return;
  const total = (et.direcoes || []).length;
  if (abaAtual !== 'caminho') trocarAba('caminho');
  if (passosRevelados < total) {
    revelarProximoPasso();
  } else if (!marcosAcesos) {
    // já revelou tudo: acende o rumo no mapa (o sopro de luz, sob demanda)
    acenderMarcosDaEtapa();
    toast(TEXTOS.marco_aceso_dica || 'Um brilho no mapa marca o rumo.');
  } else {
    toast(TEXTOS.ajuda_esgotada);
  }
}

// ---------- selar etapa ----------
function selarEtapa() {
  const et = etapaObj();
  if (!et) return;
  const tentativa = normalizar($('senha-input').value);
  if (tentativa !== normalizar(et.senha_desbloqueio)) {
    $('senha-erro').textContent = et.codigo_no_local ? (TEXTOS.codigo_errado || TEXTOS.senha_desbloqueio_errada) : TEXTOS.senha_desbloqueio_errada;
    $('senha-input').focus();
    $('senha-input').select();
    return;
  }
  etapaAtual++;
  salvarEstado();
  empurrarSincronia(); // avisa a sala; os outros celulares revelam a nova carta
  if (etapaAtual > rotaAtiva.etapas.length) { mostrarFinal(); return; }
  toast(TEXTOS.etapa_avancou);
  // o mapa se preenche: carimba a etapa recém-cumprida e a câmera voa até ela (o "achei")
  desenharCarimbos(true);
  const corrFeita = rotaAtiva.etapas[etapaAtual - 2].corredor;
  if (mapa && corrFeita && corrFeita.length) {
    const alvo = corrFeita[corrFeita.length - 1];
    setTimeout(() => { mapa.invalidateSize(); mapa.flyTo(alvo, Math.max(mapa.getZoom(), CONFIG.zoom.inicial), { duration: 1.1 }); }, 160);
  }
  setTimeout(entrarEtapa, 700); // deixa o carimbo estampar antes de trocar a carta
}

function mostrarFinal() {
  $('final-seita').textContent = rotaAtiva.seita;
  $('final-convergencia').textContent = TEXTOS.convergencia;
  $('final-convergencia').classList.add('oculto');
  const frag = rotaAtiva.fragmento_final;
  const blocos = Array.isArray(frag) ? frag : [{ voz: 'gamliel', texto: frag || '' }];
  $('final-prosseguir').textContent = TEXTOS.prosseguir;
  iniciarFluxo('final', blocos, {
    fluxo: $('final-fluxo'), pontos: $('final-pontos'), botao: $('final-prosseguir'),
  }, {
    rotuloProsseguir: TEXTOS.prosseguir,
    rotuloFim: TEXTOS.botao_entendido || 'Fim',
    aoFim: () => { $('final-convergencia').classList.remove('oculto'); $('final-prosseguir').classList.add('oculto'); },
  });
  mostrarTela('final');
}

// ---------- histórico de cartas (todos veem as pistas em ordem) ----------
function textoCorridoDaCarta(et) {
  return blocosDaCarta(et).map(blocoTexto).join('\n\n');
}

function abrirCartas() {
  if (!rotaAtiva) return;
  const lista = $('cartas-lista');
  lista.innerHTML = '';
  const total = rotaAtiva.etapas.length;
  const ate = Math.min(etapaAtual, total);
  for (let i = 0; i < ate; i++) {
    const et = rotaAtiva.etapas[i];
    const bloco = document.createElement('article');
    bloco.className = 'carta-item';
    const h = document.createElement('h3');
    h.textContent = (i + 1) + '. ' + (et.titulo || (TEXTOS.etapa_rotulo + ' ' + (i + 1)));
    const p = document.createElement('p');
    p.textContent = textoCorridoDaCarta(et);
    bloco.appendChild(h);
    bloco.appendChild(p);
    lista.appendChild(bloco);
  }
  if (ate === 0) {
    const p = document.createElement('p');
    p.className = 'texto-diwan';
    p.textContent = 'Ainda não chegou nenhuma carta.';
    lista.appendChild(p);
  }
  $('tela-cartas').classList.remove('oculto');
}

// ---------- sincronia ao vivo (sala compartilhada; degrada para manual sem sinal) ----------
async function rpcSup(nome, corpo) {
  const r = await fetch(SB_URL + '/rest/v1/rpc/' + nome, {
    method: 'POST',
    headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + SB_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  if (!r.ok) throw new Error('rpc ' + nome + ' ' + r.status);
  return r.json();
}

function iniciarSincronia() {
  if (!rotaAtiva || window.SOLO) return; // modo solo: fica fora da sala compartilhada
  sala = normalizar(rotaAtiva.senha_entrada);
  rpcSup('peula_entrar', { p_sala: sala, p_corrente: rotaAtiva.id })
    .then((r) => aplicarSincronia(r && r[0] && r[0].etapa)).catch(() => {});
  clearInterval(syncTimer);
  syncTimer = setInterval(puxarSincronia, SYNC_MS);
}

function puxarSincronia() {
  if (!sala || sincronizando) return;
  sincronizando = true;
  rpcSup('peula_estado', { p_sala: sala })
    .then((r) => aplicarSincronia(r && r[0] && r[0].etapa))
    .catch(() => {})
    .then(() => { sincronizando = false; });
}

function empurrarSincronia() {
  if (!sala) return;
  rpcSup('peula_avancar', { p_sala: sala, p_para: etapaAtual }).catch(() => {});
}

// Recebe a etapa do servidor. Se o grupo avançou, revela a(s) nova(s) carta(s).
function aplicarSincronia(etapaServidor) {
  if (!etapaServidor || !rotaAtiva || etapaServidor <= etapaAtual) return;
  const total = rotaAtiva.etapas.length;
  etapaAtual = Math.min(etapaServidor, total + 1);
  salvarEstado();
  if (etapaAtual > total) { mostrarFinal(); toast('O caminho chegou ao fim.'); return; }
  desenharCarimbos();
  const emJogo = $('tela-jogo').classList.contains('ativa') || $('tela-abertura').classList.contains('ativa');
  toast('Uma nova carta chegou.');
  if (emJogo) entrarEtapa();
  precisaVerificarEntrada = true;
}

// ---------- geolocalização ----------
function iniciarGeolocalizacao() {
  if (mock) { atualizarPosicao(mock.lat, mock.lng, 10, 'mock'); return; }
  if (!('geolocation' in navigator) || watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(
    (p) => atualizarPosicao(p.coords.latitude, p.coords.longitude, p.coords.accuracy || 0, 'gps'),
    () => setBadgeGps('sem'),
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
    if (origem !== 'botao') return;
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
  const folga = Math.min(posAtual.acc || 0, 30);
  const dentro = dist <= (et.raio_m || 50) + folga;
  if (dentro) {
    if (origem === 'botao') toast(TEXTOS.no_caminho);
  } else {
    const agora = Date.now();
    if (origem === 'auto' && agora - ultimoAvisoAutoTs < COOLDOWN_AVISO_AUTO_MS) return;
    if (origem === 'auto') ultimoAvisoAutoTs = agora;
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

  desenharCarimbos();
}

// Carimbos das estações JÁ cumpridas: o mapa se preenche conforme o grupo avança
// (Hollow Knight/Red Dead). As futuras ficam escondidas; o caminho se descobre pela pista.
function iconeCarimbo(n, novo) {
  return L.divIcon({
    className: '',
    html: '<div class="carimbo' + (novo ? ' carimbo-novo' : '') + '">' + n + '</div>',
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
}

function desenharCarimbos(animarUltimo) {
  if (!mapa || !rotaAtiva) return;
  carimbos.forEach(c => mapa.removeLayer(c));
  carimbos = [];
  const cumpridas = Math.min(etapaAtual - 1, rotaAtiva.etapas.length);
  for (let i = 0; i < cumpridas; i++) {
    const corr = rotaAtiva.etapas[i].corredor;
    if (!corr || !corr.length) continue;
    const pt = corr[corr.length - 1];
    const novo = animarUltimo && i === cumpridas - 1;
    const m = L.marker(pt, { icon: iconeCarimbo(i + 1, novo), zIndexOffset: 500 })
      .addTo(mapa)
      .bindTooltip(rotaAtiva.etapas[i].titulo || (TEXTOS.etapa_rotulo + ' ' + (i + 1)), { direction: 'top', offset: [0, -16] });
    m.on('click', abrirCartas);
    carimbos.push(m);
  }
  desenharTrilha(cumpridas);
}

// Trilha viva: uma trilha de luz dourada liga o inicio aos carimbos ja cumpridos
// (o caminho percorrido brilha, Hollow Knight). So o passado; nunca o futuro.
function desenharTrilha(cumpridas) {
  if (trilhaLayer) { mapa.removeLayer(trilhaLayer); trilhaLayer = null; }
  if (!mapa || !rotaAtiva || cumpridas < 1) return;
  const pts = [rotaAtiva.ponto_inicial];
  for (let i = 0; i < cumpridas; i++) {
    const corr = rotaAtiva.etapas[i].corredor;
    if (corr && corr.length) pts.push(corr[corr.length - 1]);
  }
  const g = L.layerGroup();
  L.polyline(pts, { color: '#ffcf5e', weight: 12, opacity: 0.15, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(g);
  L.polyline(pts, { color: '#ffe9a8', weight: 3, opacity: 0.85, dashArray: '1 10', lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(g);
  trilhaLayer = g.addTo(mapa);
}

// marcos da etapa atual: só acendem quando o grupo pede ajuda (rumo sob demanda)
function limparMarcos() {
  marcadoresMarco.forEach(m => mapa && mapa.removeLayer(m));
  marcadoresMarco = [];
}

function acenderMarcosDaEtapa() {
  limparMarcos();
  const et = etapaObj();
  if (!et || !mapa || !et.marcos) return;
  marcosAcesos = true;
  et.marcos.forEach(mk => {
    const ic = L.divIcon({ className: '', html: '<div class="marco"><span class="marco-halo"></span><span class="marco-nucleo"></span></div>', iconSize: [40, 40], iconAnchor: [20, 20] });
    const m = L.marker(mk.ponto, { icon: ic, zIndexOffset: 600 }).addTo(mapa).bindTooltip(mk.nome, { direction: 'top', offset: [0, -16] });
    marcadoresMarco.push(m);
  });
  const alvo = et.marcos[0] && et.marcos[0].ponto;
  if (alvo) mapa.flyTo(alvo, Math.max(mapa.getZoom(), CONFIG.zoom.inicial), { duration: 1.0 });
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
    if (confirm('Apagar o progresso deste celular e voltar ao portão?')) {
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

// ---------- modo ADM: coletor de coordenadas por toque no mapa ----------
// Abre direto no mapa (rota fariseus de referencia). Cada toque marca um ponto
// numerado e guarda a coordenada; "marcar GPS" usa a posicao atual; "copiar tudo"
// entrega a lista pronta para colar. Serve para levantar a rota nova em campo.
let pontosAdm = [], marcadoresAdm = [];

function iniciarAdm() {
  window.ADM = true; // no adm nao roda a verificacao automatica de caminho (nada de aviso modal)
  rotaAtiva = ROTAS.rotas.find(r => r.id === 'fariseus') || ROTAS.rotas[0];
  if (!mapa) montarMapa();
  iniciarGeolocalizacao();
  mostrarTela('jogo');
  $('painel').classList.add('oculto');
  $('controles-flutuantes').classList.add('oculto');
  $('header-texto').textContent = 'ADM · marcar pontos';
  $('selo-seita').style.background = '#d4a017';
  desenharCamadasDebug(); // mostra os corredores/rota como referencia visual
  document.documentElement.style.setProperty('--painel-alt', '0px');
  mapa.on('click', (e) => adicionarPontoAdm(e.latlng.lat, e.latlng.lng));
  montarPainelAdm();
  setTimeout(() => mapa.invalidateSize(), 80);
}

function adicionarPontoAdm(lat, lng) {
  const n = pontosAdm.length + 1;
  pontosAdm.push({ n, lat, lng });
  const ic = L.divIcon({ className: '', html: '<div class="pino-adm">' + n + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
  marcadoresAdm.push(L.marker([lat, lng], { icon: ic, zIndexOffset: 800 }).addTo(mapa));
  renderListaAdm();
}

function renderListaAdm() {
  const l = $('adm-lista');
  if (!l) return;
  l.innerHTML = pontosAdm.length
    ? pontosAdm.map(p => '<b>' + p.n + '</b>: ' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6)).join('<br>')
    : 'toque no mapa onde você está, ou onde tem algo';
}

function textoAdm() {
  return pontosAdm.map(p => p.n + ': [' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) + ']').join('\n');
}

function copiar(t, okMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => toast(okMsg)).catch(() => toast(t, 9000));
  else toast(t, 9000);
}

function montarPainelAdm() {
  const p = document.createElement('aside');
  p.id = 'painel-adm';
  p.innerHTML =
    '<div class="adm-cab">MARCAR PONTOS<span>toque no mapa onde está, ou onde tem algo. Fale no áudio o que é cada número.</span></div>' +
    '<div id="adm-lista">toque no mapa onde você está, ou onde tem algo</div>' +
    '<div class="adm-btns">' +
      '<button id="adm-gps">marcar minha posição (GPS)</button>' +
      '<button id="adm-desfazer">desfazer</button>' +
    '</div>' +
    '<div class="adm-btns">' +
      '<button id="adm-copiar" class="adm-forte">copiar tudo</button>' +
      '<button id="adm-limpar">limpar</button>' +
    '</div>';
  document.body.appendChild(p);
  $('adm-gps').addEventListener('click', () => {
    if (!posAtual) { toast(TEXTOS.sem_gps); return; }
    adicionarPontoAdm(posAtual.lat, posAtual.lng);
    if (mapa) mapa.panTo([posAtual.lat, posAtual.lng]);
  });
  $('adm-desfazer').addEventListener('click', () => {
    pontosAdm.pop();
    const m = marcadoresAdm.pop(); if (m) mapa.removeLayer(m);
    renderListaAdm();
  });
  $('adm-copiar').addEventListener('click', () => {
    if (!pontosAdm.length) { toast('Nenhum ponto ainda. Toque no mapa.'); return; }
    copiar(textoAdm(), 'Copiado! Cole no WhatsApp e me manda.');
  });
  $('adm-limpar').addEventListener('click', () => {
    if (!confirm('Apagar todos os pontos marcados?')) return;
    pontosAdm = [];
    marcadoresAdm.forEach(m => mapa.removeLayer(m));
    marcadoresAdm = [];
    renderListaAdm();
  });
}

// ---------- início ----------
init();
