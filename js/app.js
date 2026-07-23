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
const CHAVE_ADM = 'peula68_adm';               // pontos do modo ADM: salvos a cada toque (sobrevive a reload/reboot)
const CHAVE_INV = 'peula68_inv';               // inventario coletado nas chegadas (sobrevive a reload)
const CHAVE_GRAVOU = 'peula68_gravou';         // etapas com video enviado/"ja gravamos" (sobrevive a reload)
const CHAVE_NOME = 'peula68_nome';             // nome do jogador neste aparelho
const CHAVE_PAPEL = 'peula68_papel';           // papel na sala (traidor: pontos + batidos); so o sorteado tem carga
const CHAVE_DIF = 'peula68_dif';               // dificuldade escolhida (SO estetica: o jogo e identico)
const DIF_ROTULOS = { easy: 'EASY', medium: 'MEDIUM', hard: 'HARD', ultra: 'ULTRA HARD' };
const CHAVE_BEATS = 'peula68_beats';           // beats ja disparados por etapa (o pop do mapa nao repete)
const CHAVE_SACOLA = 'peula68_sacola_';        // + rota.id: a revelacao da sacola cheia ja disparou (auto uma vez)
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
const BUCKET_MIDIA = 'jogo-midia';              // Storage PRIVADO dos videos de missao (DDL em db/0004_jogo_videos.sql)

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
let etapaPendente = 0;         // etapa que o grupo ja alcancou e ainda nao aceitamos ir (convite pendente)

// estado da tela viva
let abaAtual = 'carta';
let passosRevelados = 1;       // quantos passos do caminho já apareceram (ajuda progressiva)
let marcosAcesos = false;      // os marcos da etapa foram acesos (pediu ajuda)?
let fluxos = {};               // controladores de leitura fatiada, por chave
let inventario = [];           // itens coletados nas chegadas: [{etapa, nome, glifo, sobre}]
let cerimoniaFeita = false;    // a cerimonia de chegada da etapa atual ja rolou?
let marcadorAlvo = null;       // o checkpoint/diamante aceso da etapa atual

// cronometro por etapa (o Allan quer medir quanto cada pista demora)
let etapaInicioTs = 0;         // Date.now() ao entrar na etapa atual
let cronTimer = null;
let temposEtapa = {};          // {idEtapa: duracaoMs} preenchido ao selar

// bussola: a agulha aponta pro fim do corredor da etapa
let bussolaAtiva = false;
let bussolaHeading = null;     // graus do norte do aparelho (0 = norte), quando o sensor der
let bussolaListener = null;

// gate inicial: comecar longe, ir ate o portao e tocar ESTOU AQUI
let aguardandoGate = false;
let marcadorBrilhoGate = null;

let grupoAtivo = null;         // codigo da equipe: define a sala de sincronia (rota + grupo)
let rotaPendenteGrupo = null;  // rota escolhida no portao, aguardando a escolha da equipe

// mecanica nova (rota fariseus): avanco pela MISSAO cumprida, beats no caminho, sons, foto
let selandoEtapa = false;      // guarda contra avanco reentrante (o GPS reavalia a cada fix)
let jaGravou = false;          // etapa de video: o grupo tocou "ja gravamos" (libera a chegada/o codigo)
let marcadoresBeat = [];       // marcadores dos beats acesos na etapa atual
let beatsPersist = {};         // { "rota:etapa": [indices ja disparados] }: o pop nao se repete
let sonsRota = [];             // nomes dos mp3 que a rota usa (primados no 1o gesto, iOS trava autoplay)
let fotosPendentes = [];       // fotos E videos que ainda nao subiram (reenvio best-effort nesta sessao; item de video leva kind:'video')
let nomeJogador = '';          // nome digitado na entrada do grupo (base do sorteio do traidor)
let papelInfo = null;          // null = indefinido; {papel:'fiel'} ou {papel:'traidor', pontos, batidos}
let jogadorRegistrado = false; // ja avisou o servidor que este celular esta na sala
let marcadoresTraidor = {};    // id do ponto -> marcador no mapa (so no celular do traidor)
let traidorFixes = {};         // id do ponto -> fixes de GPS seguidos dentro do raio
let traidorPendentes = [];     // pontos batidos aguardando rede pro RPC

const $ = (id) => document.getElementById(id);

// ---------- estado no localStorage (nunca travar se indisponível) ----------
function lerEstado() {
  try { return JSON.parse(localStorage.getItem(CHAVE_ESTADO)) || null; }
  catch (e) { return null; }
}
function salvarEstado() {
  try { localStorage.setItem(CHAVE_ESTADO, JSON.stringify({ rota: rotaAtiva.id, etapa: etapaAtual, grupo: grupoAtivo || '' })); }
  catch (e) { /* modo privado sem storage: o jogo segue, só não sobrevive a reload */ }
}
function limparEstado() {
  try {
    localStorage.removeItem(CHAVE_ESTADO); localStorage.removeItem(CHAVE_INV); localStorage.removeItem(CHAVE_BEATS); localStorage.removeItem(CHAVE_GRAVOU); localStorage.removeItem(CHAVE_PAPEL);
    // zera as flags da revelacao da sacola (uma por rota): no replay a virada dispara de novo
    Object.keys(localStorage).filter(k => k.indexOf(CHAVE_SACOLA) === 0).forEach(k => localStorage.removeItem(k));
  } catch (e) {}
  beatsPersist = {};
}
function lerInventario() { try { return JSON.parse(localStorage.getItem(CHAVE_INV)) || []; } catch (e) { return []; } }
function salvarInventario() { try { localStorage.setItem(CHAVE_INV, JSON.stringify(inventario)); } catch (e) {} }
function lerBeatsPersist() { try { return JSON.parse(localStorage.getItem(CHAVE_BEATS)) || {}; } catch (e) { return {}; } }
function salvarBeatsPersist() { try { localStorage.setItem(CHAVE_BEATS, JSON.stringify(beatsPersist)); } catch (e) {} }
function jaGravouSalvo(etId) { try { return (JSON.parse(localStorage.getItem(CHAVE_GRAVOU)) || []).indexOf(etId) >= 0; } catch (e) { return false; } }
function marcarGravou(etId) {
  try {
    const v = JSON.parse(localStorage.getItem(CHAVE_GRAVOU)) || [];
    if (v.indexOf(etId) < 0) { v.push(etId); localStorage.setItem(CHAVE_GRAVOU, JSON.stringify(v)); }
  } catch (e) {}
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

// ---------- audio: prime no 1o gesto (iOS bloqueia autoplay), toca por nome ----------
// Os mp3 vivem em audio/. iOS so deixa tocar depois de um gesto do usuario: no 1o toque
// relevante (enviar o retrato, "estou aqui", digitar a senha) primamos todos os sons da
// rota com um play mudo+pause, que destrava o elemento pra tocar com som fora do gesto.
let audioCache = {};
let audioPronto = false;
function audioEl(nome) {
  if (!nome) return null;
  if (!audioCache[nome]) { const a = new Audio('audio/' + nome + '.mp3'); a.preload = 'auto'; audioCache[nome] = a; }
  return audioCache[nome];
}
function primarAudio() {
  if (audioPronto || !sonsRota.length) return;
  audioPronto = true;
  sonsRota.forEach(n => {
    const a = audioEl(n);
    try {
      a.muted = true;
      const p = a.play();
      if (p && p.then) p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
      else { a.pause(); a.currentTime = 0; a.muted = false; }
    } catch (e) { try { a.muted = false; } catch (e2) {} }
  });
  // reload no meio de uma etapa: a trilha ficou presa pelo autoplay (tocarTrilha rodou sem gesto e
  // deixou trilhaAtual setada). O 1o gesto passa por aqui, entao retoma a trilha pendurada; sem isso
  // a etapa restaurada (e as seguintes com a MESMA trilha) ficam mudas
  if (trilhaAtual && trilhaAtual.paused) { try { const p = trilhaAtual.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
}
let somAtivo = null;   // som pontual tocando agora: a trilha espera ele acabar
function aoAcabarSom(a, cb) {
  const done = () => {
    clearTimeout(tm);
    a.removeEventListener('ended', done); a.removeEventListener('error', done);
    if (somAtivo === a) somAtivo = null;
    cb();
  };
  const tm = setTimeout(done, 12000);   // som que nunca dispara "ended" nao pode deixar a trilha muda
  a.addEventListener('ended', done);
  a.addEventListener('error', done);
}
function tocarSom(nome) {
  const a = audioEl(nome);
  if (!a) return;
  // um som fala SOZINHO: a trilha de fundo segura a respiracao e volta quando ele acaba
  somAtivo = a;
  if (trilhaAtual && !trilhaAtual.paused) { try { trilhaAtual.pause(); } catch (e) {} }
  aoAcabarSom(a, () => {
    if (trilhaAtual && trilhaAtual.paused) { try { const p = trilhaAtual.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
  });
  try { a.muted = false; a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}
// trilha de fundo por etapa: musica ambiente em loop, volume baixo, some ao trocar de etapa.
// et.trilha = nome do mp3; sem trilha na etapa nova, a de antes para (o "do 1o ao 2o ponto").
let trilhaAtual = null;
function tocarTrilha(nome) {
  if (!nome) { pararTrilha(); return; }
  if (trilhaAtual && trilhaAtual._trilha === nome) return; // ja e essa: nao reinicia
  pararTrilha();
  const a = audioEl(nome);
  if (!a) return;
  if (a._fadeInt) { clearInterval(a._fadeInt); a._fadeInt = null; } // cancela fade pendente neste elemento
  a._trilha = nome;
  a.loop = true;
  a.volume = 0.45;   // fundo: acompanha sem abafar quem le a carta em voz alta
  trilhaAtual = a;
  if (somAtivo && !somAtivo.paused && !somAtivo.ended) {
    return;   // um som pontual esta falando: quando ele acabar, o callback dele retoma ESTA trilha (pausada)
  }
  try { a.muted = false; a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}
function pararTrilha() {
  const a = trilhaAtual;
  if (!a) return;
  trilhaAtual = null;
  if (a._fadeInt) { clearInterval(a._fadeInt); a._fadeInt = null; }
  try {
    let v = a.volume;
    a._fadeInt = setInterval(() => {
      v -= 0.09;
      if (v <= 0) { clearInterval(a._fadeInt); a._fadeInt = null; try { a.pause(); a.currentTime = 0; } catch (e) {} a.volume = 0.45; }
      else { try { a.volume = Math.max(0, v); } catch (e) {} }
    }, 60);
  } catch (e) { try { a.pause(); } catch (e2) {} }
}
// junta os mp3 que a rota realmente usa (retrato de abertura, chegadas e beats), pra primar so eles
function coletarSonsDaRota(rota) {
  const s = new Set();
  if (rota && rota.missao_abertura && rota.missao_abertura.som) s.add(rota.missao_abertura.som);
  if (rota && rota.revelacao_sacola) s.add('sino');   // a virada da sacola cheia toca o sino: prima junto (iOS)
  (rota && rota.etapas || []).forEach(et => {
    if (et.som_chegada) s.add(et.som_chegada);
    if (et.trilha) s.add(et.trilha);
    (et.beats || []).forEach(b => { if (b.som) s.add(b.som); });
  });
  sonsRota = Array.from(s);
}

function mostrarTela(nome) {
  $('aviso').classList.add('oculto'); // aviso é contextual: trocou de tela, morreu
  // overlays soltos também morrem na troca de tela: um sync pode trocar a tela por baixo e
  // deixá-los presos (a sacola, as cartas, o lightbox, o coach) por cima da tela nova
  ['tela-inventario', 'tela-cartas', 'tela-foto', 'coach-socorros', 'papel-secreto', 'tela-galeria'].forEach(o => { const el = $(o); if (el) el.classList.add('oculto'); });
  ['portao', 'grupo', 'abertura', 'jogo', 'final'].forEach(t => $('tela-' + t).classList.toggle('ativa', t === nome));
  if (nome === 'jogo' && mapa) setTimeout(() => { mapa.invalidateSize(); ajustarMapaAoPainel(); }, 60);
}

// blocos de leitura: uma string vira {voz:narrador}; objeto {voz,texto} passa direto
function blocoTexto(b) { return typeof b === 'string' ? b : (b && b.texto) || ''; }
function blocoVoz(b) { return typeof b === 'string' ? 'narrador' : (b && b.voz) || 'narrador'; }
// marca o asterisco de "fato historico real" no texto (conteudo proprio dos JSON, sem risco de injecao)
function textoComAsterisco(txt) {
  const esc = (txt || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*/g, '<sup class="fato-real" title="fato historico real">*</sup>');
}
function rotuloVoz(voz) {
  switch (voz) {
    case 'gamliel': return 'Carta de Rabban Gamliel';
    case 'bilhete': return 'Um bilhete no chão';
    case 'circulo': return 'O capitão lê em voz alta';
    case 'viajante': return TEXTOS.eco_titulo || 'Você, que veio de longe';
    case 'combinados': return 'Antes de descer';
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
  if (params.has('reset')) { limparEstado(); try { localStorage.removeItem('peula68_coach'); localStorage.removeItem('peula68_nocron'); } catch (e) {} }
  // modo solo: joga 100% local, sem entrar na sala compartilhada (teste/playtest e fallback do dia)
  window.SOLO = params.has('solo');
  // link direto pra equipe (ex.: ?grupo=CEDRO47): entra sem passar pela tela de grupo
  if (params.get('grupo')) grupoAtivo = params.get('grupo');
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
  inventario = lerInventario();
  beatsPersist = lerBeatsPersist();

  // modo ADM: tela de coleta de coordenadas (toque no mapa marca pontos numerados)
  if (params.has('adm')) { iniciarAdm(); return; }

  const salvo = lerEstado();
  if (salvo) {
    const rota = ROTAS.rotas.find(r => r.id === salvo.rota);
    if (rota && salvo.etapa >= 1 && salvo.etapa <= rota.etapas.length + 1) {
      if (salvo.grupo) grupoAtivo = salvo.grupo;   // reusa a equipe salva (nao pergunta de novo)
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
    // solo ou link com a equipe ja definida: entra direto. Senao, cria/entra no grupo.
    if (window.SOLO || grupoAtivo) { salvarEstado(); entrarNoJogo(rota, 1, true); }
    else { mostrarTelaGrupo(rota); }
  });

  // tela de grupo (criar ou entrar numa equipe)
  $('grupo-criar').addEventListener('click', criarGrupo);
  // sussurro (beats/revela): toque fecha na hora; o marcador no mapa guarda o texto pra reler
  const sus = $('sussurro');
  if (sus) sus.addEventListener('click', fecharSussurro);
  // dificuldade (so estetica): marca o chip, guarda e responde com um toast de estilo
  document.querySelectorAll('.dif-chip').forEach((ch) => {
    ch.addEventListener('click', () => {
      document.querySelectorAll('.dif-chip').forEach((c) => c.classList.remove('ativa'));
      ch.classList.add('ativa');
      const d = ch.getAttribute('data-dif');
      try { localStorage.setItem(CHAVE_DIF, d); } catch (e) {}
      toast(TEXTOS['dif_toast_' + d] || DIF_ROTULOS[d] || '', 3500);
    });
  });
  try {
    const d = localStorage.getItem(CHAVE_DIF);
    if (d) { const ch = document.querySelector('.dif-chip[data-dif="' + d + '"]'); if (ch) ch.classList.add('ativa'); }
  } catch (e) {}
  // papel secreto (so o traidor chega a ver este overlay)
  $('papel-revelar').addEventListener('click', () => {
    $('papel-conteudo').classList.remove('oculto');
    $('papel-revelar').classList.add('oculto');
    $('papel-fechar').classList.remove('oculto');
  });
  $('papel-fechar').addEventListener('click', () => $('papel-secreto').classList.add('oculto'));
  // segurar o selo da seita (600ms) reabre a carta; nos celulares fieis nao faz nada
  let seloTimer = null;
  const selo = $('selo-seita');
  if (selo) {
    const arma = () => { seloTimer = setTimeout(() => { if (papelInfo && papelInfo.papel === 'traidor') abrirPapelSecreto(); }, 600); };
    const solta = () => { if (seloTimer) { clearTimeout(seloTimer); seloTimer = null; } };
    selo.addEventListener('pointerdown', arma);
    selo.addEventListener('pointerup', solta);
    selo.addEventListener('pointerleave', solta);
  }
  $('grupo-comecar').addEventListener('click', comecarComGrupoCriado);
  $('form-grupo').addEventListener('submit', (e) => { e.preventDefault(); entrarGrupoDigitado(); });

  // abertura (viajante + identidade), fatiada
  $('abertura-prosseguir').addEventListener('click', () => avancarFluxo('abertura'));
  $('abertura-voltar').addEventListener('click', () => voltarFluxo('abertura'));
  $('abertura-pular').addEventListener('click', () => { if (fluxos.abertura) fluxos.abertura.aoFim(); });

  // painel: abas, puxador
  document.querySelectorAll('.aba-btn').forEach(b => b.addEventListener('click', () => trocarAba(b.getAttribute('data-aba'))));
  $('painel-puxador').addEventListener('click', alternarPainel);
  $('carta-prosseguir').addEventListener('click', () => avancarFluxo('carta'));
  $('carta-voltar').addEventListener('click', () => voltarFluxo('carta'));
  $('caminho-mais').addEventListener('click', revelarProximoPasso);
  $('caminho-ponto').addEventListener('click', voltarAoUltimoPonto);

  $('botao-centrar').addEventListener('click', () => {
    if (posAtual && mapa) voarPara([posAtual.lat, posAtual.lng], Math.max(mapa.getZoom(), CONFIG.zoom.inicial), 0.8);
    else toast(TEXTOS.sem_gps);
  });
  $('botao-ajuda').addEventListener('click', pedirAjuda);
  $('botao-inventario').addEventListener('click', abrirInventario);
  $('botao-bussola').addEventListener('click', toggleBussola);
  $('botao-galeria').addEventListener('click', abrirGaleria);
  $('galeria-fechar').addEventListener('click', () => $('tela-galeria').classList.add('oculto'));
  $('painel-mostrar').addEventListener('click', restaurarPainel);
  $('gate-botao').addEventListener('click', abrirPrimeiraEtapa);
  $('convite-ir').addEventListener('click', aceitarAvanco);
  $('convite-depois').addEventListener('click', recusarAvanco);
  $('ir-grupo').addEventListener('click', aceitarAvanco);
  $('foto-fechar').addEventListener('click', fecharFoto);
  $('coach-fechar').addEventListener('click', () => {
    $('coach-socorros').classList.add('oculto');
    try { localStorage.setItem('peula68_coach', '1'); } catch (e) {}
  });
  $('cronometro').addEventListener('click', () => {
    try { localStorage.setItem('peula68_nocron', '1'); } catch (e) {}
    $('cronometro').classList.add('oculto');
    pararCronometro();
    toast(TEXTOS.cron_oculto || 'Cronômetro escondido. Recarregue com ?reset para trazer de volta.');
  });
  $('inv-voltar').addEventListener('click', () => $('tela-inventario').classList.add('oculto'));
  $('espelho-fechar').addEventListener('click', fecharEspelho);
  $('espelho-carta').addEventListener('click', () => $('espelho-carta').classList.toggle('virada'));
  $('espelho-carta').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('espelho-carta').classList.toggle('virada'); } });
  $('rev-fechar').addEventListener('click', fecharRevelacaoSacola);

  $('form-senha').addEventListener('submit', (e) => { e.preventDefault(); selarEtapa(); });
  // no celular, ao abrir o teclado, rola para o botao nao ficar escondido atras dele
  $('senha-input').addEventListener('focus', () => {
    setTimeout(() => { const b = $('senha-botao'); if (b) b.scrollIntoView({ block: 'center' }); }, 320);
  });

  // final, fatiado
  $('final-prosseguir').addEventListener('click', () => avancarFluxo('final'));
  $('final-voltar').addEventListener('click', () => voltarFluxo('final'));

  // histórico de cartas (overlay)
  $('cartas-voltar').addEventListener('click', () => $('tela-cartas').classList.add('oculto'));

  $('aviso-fechar').addEventListener('click', () => $('aviso').classList.add('oculto'));

  // mecanica nova: retrato de abertura + foto de missao (avanco pela missao cumprida)
  $('gate-retrato-btn').addEventListener('click', () => {
    primarAudio();
    // trava suave de GPS: com posicao conhecida, o retrato so se tira NO portao (sem GPS, deixa)
    if (!pertoDoGate()) { toast(TEXTOS.gate_longe || 'Cheguem primeiro ao portão: o retrato se tira lá.', 5000); return; }
    $('gate-foto-input').click();
  });
  $('gate-foto-input').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) enviarRetratoAbertura(f); });
  $('missao-foto-input').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) enviarFotoMissao(f); });
  $('sussurro').addEventListener('click', fecharSussurro);
  window.addEventListener('online', tentarReenviarPendentes); // voltou a rede: reenvia as fotos e videos pendentes

  document.addEventListener('visibilitychange', () => { if (!document.hidden) puxarSincronia(); });

  // 7 toques no cabeçalho do mapa abrem o painel de calibração
  let taps = 0, tapTimer = null;
  $('header-mapa').addEventListener('click', () => {
    taps++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { taps = 0; }, 3000);
    if (taps >= 7) { taps = 0; ativarDebug(); }
  });

  // Safari iOS: a barra de endereço aparecendo/sumindo muda innerHeight; reajusta painel+mapa juntos
  let redimTimer = null;
  const aoRedimensionar = () => {
    // teclado virtual (Android que encolhe o layout viewport) muda innerHeight: não reajusta com
    // um campo focado, senão o painel "pula" ao digitar a senha; no blur o resize seguinte corrige
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    clearTimeout(redimTimer); redimTimer = setTimeout(ajustarMapaAoPainel, 150);
  };
  window.addEventListener('resize', aoRedimensionar);
  window.addEventListener('orientationchange', aoRedimensionar);

  setInterval(() => { if (rotaAtiva && !window.ADM && !aguardandoGate && etapaAtual <= rotaAtiva.etapas.length) verificar('auto'); }, INTERVALO_AUTO_MS);
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
  const p = document.createElement('p'); p.innerHTML = textoComAsterisco(blocoTexto(b)); art.appendChild(p);
  fluxo.appendChild(art);
  requestAnimationFrame(() => art.classList.add('entrou'));

  if (st.els.pontos) renderPontos(st.els.pontos, st.blocos.length, st.i);
  const ultimo = st.i >= st.blocos.length - 1;
  st.els.botao.textContent = ultimo ? (st.opts.rotuloFim || TEXTOS.prosseguir) : (st.opts.rotuloProsseguir || TEXTOS.prosseguir);
  if (st.els.pular) st.els.pular.classList.toggle('oculto', ultimo);
  if (st.els.voltar) st.els.voltar.classList.toggle('oculto', st.i <= 0); // voltar/reler: some no primeiro bloco
}

function avancarFluxo(chave) {
  const st = fluxos[chave];
  if (!st) return;
  if (st.i >= st.blocos.length - 1) { st.aoFim(); return; }
  st.i++;
  renderFluxoBloco(chave);
}

// voltar/reler: recua um bloco na leitura fatiada (bug do playtest: so dava pra avancar)
function voltarFluxo(chave) {
  const st = fluxos[chave];
  if (!st || st.i <= 0) return;
  st.i--;
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

// ---------- grupo: cada equipe tem sua sala de sincronia (rota + codigo) ----------
// A sala deixou de ser a senha da seita (igual pra todo celular) e passou a ser a EQUIPE.
// Varios celulares no mesmo codigo = mesma sala, isolada das outras equipes e dos eventos
// passados. O 1o da equipe cria (o app gera um codigo facil de ditar) e os outros digitam.
const GRUPO_PALAVRAS = ['CEDRO', 'TORRE', 'MURO', 'FONTE', 'TRIGO', 'TEMPLO', 'PEDRA', 'ARCO', 'OURO', 'RIO', 'SINO', 'FOLHA', 'RAIZ', 'LUZ'];

function gerarCodigoGrupo() {
  const palavra = GRUPO_PALAVRAS[Math.floor(Math.random() * GRUPO_PALAVRAS.length)];
  const num = 10 + Math.floor(Math.random() * 90); // 2 digitos: quase sem colisao entre equipes
  return palavra + ' ' + num;
}

function mostrarTelaGrupo(rota) {
  rotaPendenteGrupo = rota;
  $('grupo-codigo-bloco').classList.add('oculto');
  $('grupo-input').value = '';
  $('grupo-erro').textContent = '';
  mostrarTela('grupo');
}

function criarGrupo() {
  const codigo = gerarCodigoGrupo();
  $('grupo-codigo').textContent = codigo;
  $('grupo-comecar').dataset.codigo = codigo;
  $('grupo-codigo-bloco').classList.remove('oculto');
}

// nome do jogador: base do sorteio do traidor e da revelacao final (fica salvo no aparelho)
function pegarNomeDigitado() {
  const el = $('nome-input');
  const n = el ? (el.value || '').trim().slice(0, 30) : '';
  if (n) { nomeJogador = n; try { localStorage.setItem(CHAVE_NOME, n); } catch (e) {} }
  return n;
}

function comecarComGrupoCriado() {
  if (!pegarNomeDigitado()) {
    $('grupo-erro').textContent = TEXTOS.nome_falta || 'Escreva seu nome antes de entrar.';
    const el = $('nome-input'); if (el) el.focus();
    return;
  }
  const codigo = $('grupo-comecar').dataset.codigo;
  if (codigo) entrarComGrupo(codigo);
}

function entrarGrupoDigitado() {
  if (!pegarNomeDigitado()) {
    $('grupo-erro').textContent = TEXTOS.nome_falta || 'Escreva seu nome antes de entrar.';
    const el = $('nome-input'); if (el) el.focus();
    return;
  }
  const codigo = $('grupo-input').value;
  if (normalizar(codigo).length < 3) {
    $('grupo-erro').textContent = TEXTOS.grupo_codigo_curto || 'Digitem o código da equipe (a palavra e o número).';
    $('grupo-input').focus();
    return;
  }
  entrarComGrupo(codigo);
}

function entrarComGrupo(codigo) {
  grupoAtivo = codigo;
  etapaAtual = 1;
  rotaAtiva = rotaPendenteGrupo;
  salvarEstado();
  entrarNoJogo(rotaPendenteGrupo, 1, true);
}

// ---------- fluxo do jogo ----------
function entrarNoJogo(rota, etapa, novoJogo) {
  rotaAtiva = rota;
  etapaAtual = etapa;
  coletarSonsDaRota(rota);   // lista os mp3 da rota pra primar no 1o gesto do usuario
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
  if (!ab || (!ab.viajante && !ab.identidade)) { mostrarGateInicial(); return; } // seita sem abertura: direto pro gate
  const blocos = []
    .concat((ab.viajante || []).map(t => ({ voz: 'viajante', texto: t })))
    .concat((ab.identidade || []).map(t => ({ voz: 'identidade', texto: t })))
    .concat((ab.combinados || []).map(t => ({ voz: 'combinados', texto: t })));
  $('abertura-rotulo').textContent = rotaAtiva.seita + ' · ' + (TEXTOS.abertura_viajante_titulo || '');
  $('abertura-prosseguir').textContent = TEXTOS.prosseguir;
  $('abertura-pular').textContent = TEXTOS.abertura_pular || 'Pular';
  iniciarFluxo('abertura', blocos, {
    fluxo: $('abertura-fluxo'), pontos: $('abertura-pontos'), botao: $('abertura-prosseguir'), pular: $('abertura-pular'), voltar: $('abertura-voltar'),
  }, {
    rotuloProsseguir: TEXTOS.prosseguir,
    rotuloFim: TEXTOS.abertura_para_mapa || TEXTOS.prosseguir,
    aoFim: () => mostrarGateInicial(), // depois da leitura, o gate: ir ate o portao e tocar ESTOU AQUI
  });
  mostrarTela('abertura');
}

function atualizarHeader() {
  const total = rotaAtiva.etapas.length;
  let rotulo = etapaAtual > total
    ? rotaAtiva.seita
    : rotaAtiva.seita + ' · ' + TEXTOS.etapa_rotulo + ' ' + etapaAtual + ' ' + TEXTOS.de + ' ' + total;
  let dif = '';
  try { dif = localStorage.getItem(CHAVE_DIF) || ''; } catch (e) {}
  if (DIF_ROTULOS[dif]) rotulo += ' · ' + DIF_ROTULOS[dif];   // so estetico: o selo da escolha acompanha a noite
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
  if (aguardandoGate) sairDoGate(); // nunca abrir uma etapa com o card do gate ("ESTOU AQUI") preso por cima
  atualizarHeader();
  passosRevelados = 1;
  marcosAcesos = false;
  selandoEtapa = false;   // etapa nova: solta o guarda de avanco
  jaGravou = jaGravouSalvo(et.id);   // sobrevive a reload: video enviado/"ja gravamos" nao se pede de novo
  cerimoniaFeita = inventario.some(x => x.etapa === et.id); // se ja chegou/coletou, nao repete a cerimonia
  limparMarcos();
  limparMarcadoresBeat();
  limparAlvo();
  if (cerimoniaFeita) acenderAlvoAtual(et, true);   // reentrou numa etapa ja "chegada" (reload): o diamante do checkpoint volta ao mapa, sem voar
  else if (et.guia_diamante) acenderAlvoAtual(et);  // etapa "siga o diamante" (sem direcoes de texto): acende o destino ao entrar, pra guiar
  redesenharBeatsDisparados(et);   // reload no meio da etapa: os beats ja vistos voltam ao mapa (sem pop/som)
  desenharPontosTraidor();         // so desenha algo no celular do traidor (idempotente)
  renderCarta();
  renderCaminho();
  renderMissao();
  trocarAba('carta');
  mostrarTela('jogo');
  desenharCarimbos();
  atualizarContadorInv();
  iniciarCronometro();               // zera e mostra o tempo desta etapa
  if (bussolaAtiva) atualizarBussola(); // a bussola passa a apontar pro novo destino
  talvezMostrarCoach();              // apresenta os socorros uma vez (na 1a etapa vista neste aparelho)
  precisaVerificarEntrada = true;
  verificar('entrada');
  sincronizarConvite();   // se ja alcancamos o grupo, o convite some; senao mantem a pilula coerente
  if (et.trilha) tocarTrilha(et.trilha); else pararTrilha();   // trilha de fundo da etapa (some quando a proxima nao tem)
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
  preencherFotos($('carta-fotos'), et.fotos);            // a etapa abre pela foto do destino (foto -> historia -> caminho)
  $('carta-fotos-bloco').classList.toggle('oculto', !(et.fotos && et.fotos.length));
  const nf = (et.fotos || []).length;
  const rotf = $('carta-fotos-bloco').querySelector('.etapa-fotos-rotulo');
  if (rotf) rotf.textContent = nf + (nf === 1 ? ' foto · ' : ' fotos · ') + (TEXTOS.fotos_toque || 'toque pra ampliar');
  const blocos = blocosDaCarta(et);
  iniciarFluxo('carta', blocos, {
    fluxo: $('carta-fluxo'), pontos: $('carta-pontos'), botao: $('carta-prosseguir'), voltar: $('carta-voltar'),
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

  preencherFotos($('caminho-fotos'), et.fotos);   // referencia enquanto anda, com lightbox (modo Easy)
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
  // teclado numerico so quando o codigo esperado e todo digito: "CHAIN GATE" (e os
  // codigos com palavra do item) precisam de letras, e inputmode=numeric esconde o abc
  const soDigitos = /^[0-9]*$/.test(normalizar(et.senha_desbloqueio || ''));
  $('senha-input').setAttribute('inputmode', ehCodigo && soDigitos ? 'numeric' : 'text');
  $('senha-erro').textContent = '';
  montarAcaoMissao(et);   // o botao da missao (foto / "ja gravamos") conforme et.avanco; a senha vira reserva
}

// ---------- avanco pela missao cumprida (foto sobe / "ja gravamos" libera codigo ou GPS) ----------
// A troca de etapa deixa de depender so da senha: a MISSAO e o gatilho. Foto que sobe avanca
// sozinha; video pede o toque "ja gravamos" antes de liberar o codigo (E4) ou a chegada (E5).
// A senha_desbloqueio continua SEMPRE como reserva do madrich (nunca travar).
function botaoAcaoMissao(txt, id) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'botao botao-missao';
  b.id = id;
  b.textContent = txt;
  return b;
}

function montarAcaoMissao(et) {
  const cont = $('missao-acao');
  if (!cont) return;
  cont.innerHTML = '';
  const avanco = et.avanco || (et.codigo_no_local ? 'codigo' : '');
  const form = $('form-senha');
  const reservaRot = $('missao-reserva-rotulo');
  // padrao: a senha e a RESERVA do madrich, sempre a vista (o jogo nunca trava por falta de foto/GPS)
  form.classList.remove('oculto');
  if (reservaRot) { reservaRot.classList.remove('oculto'); reservaRot.textContent = TEXTOS.missao_reserva || 'Palavra do madrich (reserva)'; }

  if (avanco === 'foto') {
    const b = botaoAcaoMissao(TEXTOS.missao_enviar_foto || 'Enviar a foto e seguir', 'missao-foto-btn');
    b.addEventListener('click', () => {
      primarAudio();
      // trava suave de GPS: a foto da missao se tira NO lugar (sem GPS/fix, deixa; a reserva do madrich cobre)
      if (!pertoDoCheckpoint(et)) { toast(TEXTOS.missao_longe || 'Ainda não chegaram ao lugar da missão. Sigam o mapa: a foto se tira lá.', 5000); return; }
      $('missao-foto-input').click();
    });
    cont.appendChild(b);
  } else if (avanco === 'codigo') {
    if (et.sobe_video) {
      // missao de video que SOBE pro Storage (sobe_video). A missao e enviar o video; o GATE
      // continua sendo o codigo CHAIN GATE achado no local, que fica a vista e nunca trava (e e
      // tambem a palavra de reserva do madrich). Enviar/enfileirar o video nao avanca sozinho.
      montarBotaoVideo(cont, et.id, null);
      if (reservaRot) reservaRot.classList.add('oculto');   // o campo abaixo JA e o codigo do local
      // form-senha fica VISIVEL de proposito: digitar o codigo avanca, tenha o video subido ou nao
    } else if (jaGravou) {
      // reload depois do "ja gravamos": o campo do codigo volta revelado, sem pedir de novo
      if (reservaRot) reservaRot.classList.add('oculto');
    } else {
      // sem sobe_video: "ja gravamos" (so mostra ao madrich) revela o campo do codigo local
      const b = botaoAcaoMissao(TEXTOS.missao_ja_gravamos || 'Já gravamos', 'missao-gravou-btn');
      b.addEventListener('click', () => { primarAudio(); jaGravou = true; marcarGravou(et.id); revelarCampoCodigo(); });
      cont.appendChild(b);
      form.classList.add('oculto');                       // ate "ja gravamos", o campo do codigo fica velado
      if (reservaRot) reservaRot.classList.add('oculto');
    }
  } else if (avanco === 'video') {
    if (et.sobe_video) {
      // ultima etapa: enviar o video (sobe pro Storage) habilita a chegada por GPS ao ponto final.
      // O form-senha (reserva) segue visivel: o madrich pode ditar a palavra se o GPS nao pegar.
      montarBotaoVideo(cont, et.id, () => { jaGravou = true; marcarGravou(et.id); avisarChegadaFinal(); });
    } else {
      // sem sobe_video: "ja gravamos" habilita a chegada por GPS ao ponto final
      const b = botaoAcaoMissao(TEXTOS.missao_ja_gravamos || 'Já gravamos', 'missao-gravou-btn');
      b.addEventListener('click', () => { primarAudio(); jaGravou = true; marcarGravou(et.id); avisarChegadaFinal(); });
      cont.appendChild(b);
    }
  }
  // avanco 'gps' ou rotas antigas (sem avanco): sem botao; a chegada por GPS e a senha resolvem
}

// botao "Enviar o video" + input de video (capture), criado na hora (nao depende do HTML).
// aoConcluir roda DEPOIS que o video sobe OU entra na fila offline: nunca prende o grupo.
function montarBotaoVideo(cont, etapaId, aoConcluir) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'video/*';
  inp.setAttribute('capture', 'environment');   // abre a camera (traseira) no celular; no desktop vira seletor de arquivo
  inp.hidden = true;
  inp.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) enviarVideoMissao(f, etapaId, aoConcluir);
  });
  const b = botaoAcaoMissao(TEXTOS.missao_enviar_video || 'Enviar o vídeo', 'missao-video-btn');
  b.addEventListener('click', () => { primarAudio(); inp.click(); });
  cont.appendChild(b);
  cont.appendChild(inp);
}

function revelarCampoCodigo() {
  $('form-senha').classList.remove('oculto');
  const rot = $('missao-reserva-rotulo');
  if (rot) rot.classList.add('oculto');   // aqui o campo E o codigo do local, nao a "reserva"
  toast(TEXTOS.missao_gravou_codigo || 'Agora leiam o número gravado na pedra e digitem.');
  setTimeout(() => { const i = $('senha-input'); if (i) i.focus(); }, 200);
}

function avisarChegadaFinal() {
  toast(TEXTOS.missao_gravou_gps || 'Agora cheguem ao alto: as pedras avisam quando chegarem.', 6000);
  verificar('entrada');   // reavalia ja: se o grupo ja esta no ponto final, a chegada fecha a caca
}

// ---------- abas e painel deslizante ----------
function trocarAba(nome) {
  abaAtual = nome;
  document.querySelectorAll('.aba-btn').forEach(b => b.classList.toggle('ativa', b.getAttribute('data-aba') === nome));
  ['carta', 'caminho', 'missao'].forEach(a => $('aba-' + a).classList.toggle('ativa', a === nome));
  // a carta e a missão querem espaço (leitura); o caminho quer o mapa grande
  const alto = (nome === 'carta' || nome === 'missao');
  const p = $('painel');
  p.classList.remove('painel-fechado');   // trocar de aba sempre traz o painel de volta
  p.classList.toggle('painel-baixo', !alto);
  atualizarPinoMostrar();
  ajustarMapaAoPainel();
}

// o puxador cicla: aberto (56vh) -> baixo (34vh) -> mapa cheio (o painel some) -> aberto.
// resolve o pedido do playtest: "minimizar o menu e ver o mapa na tela inteira".
function alternarPainel() {
  const p = $('painel');
  if (p.classList.contains('painel-fechado')) {
    p.classList.remove('painel-fechado', 'painel-baixo');   // volta pro aberto
  } else if (p.classList.contains('painel-baixo')) {
    p.classList.remove('painel-baixo');
    p.classList.add('painel-fechado');                       // some de vez: mapa em tela cheia
  } else {
    p.classList.add('painel-baixo');                         // aberto -> baixo
  }
  atualizarPinoMostrar();
  ajustarMapaAoPainel();
}

// o pino flutuante ("mostrar as instruções") traz o painel de volta em tela cheia
function restaurarPainel() {
  $('painel').classList.remove('painel-fechado', 'painel-baixo');
  atualizarPinoMostrar();
  ajustarMapaAoPainel();
}

function atualizarPinoMostrar() {
  const fechado = $('painel').classList.contains('painel-fechado');
  $('painel-mostrar').classList.toggle('oculto', !fechado);
}

// o mapa termina onde o painel começa (os dois sempre visíveis; ou o mapa inteiro se fechado).
// O bottom do mapa e dos controles vai DIRETO (inline), nao por var(--painel-alt): o Chromium
// congela um `bottom` com transition quando o valor vem de uma var() que muda (era a "tela preta":
// o mapa nao crescia ao recolher o painel). Inline anima e nao trava. A var segue alimentando o
// toast e o item-ganho, que nao tem transition de bottom e por isso nao congelam.
function ajustarMapaAoPainel() {
  const p = $('painel');
  const fechado = p.classList.contains('painel-fechado') || p.classList.contains('oculto');
  const painelVh = fechado ? 0 : (p.classList.contains('painel-baixo') ? 34 : 56);
  const debugPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--debug-alt')) || 0;
  const painelPx = Math.round(painelVh / 100 * window.innerHeight);   // altura do painel em px (base innerHeight)
  const altPx = painelPx + debugPx;                                   // o mapa e os controles terminam onde o painel+debug começam
  document.documentElement.style.setProperty('--painel-alt', fechado ? '0px' : painelVh + 'vh');
  // o painel passa a usar a MESMA base (innerHeight) do mapa: no Safari iOS o 56vh/34vh do CSS media
  // a viewport GRANDE (barra retraída) e o painel cobria a sacola/ajuda, que o JS posiciona por
  // innerHeight; fixando o painel em px os dois batem sempre. Fechado: a classe .painel-fechado manda.
  p.style.height = fechado ? '' : painelPx + 'px';
  const mapaEl = $('mapa'); if (mapaEl) mapaEl.style.bottom = altPx + 'px';
  const ctrl = $('controles-flutuantes'); if (ctrl) ctrl.style.bottom = (altPx + 12) + 'px';
  if (!mapa) return;
  // acompanha a transicao para o Leaflet preencher enquanto o mapa cresce/encolhe
  let n = 0;
  const iv = setInterval(() => { mapa.invalidateSize({ animate: false }); if (++n >= 9) clearInterval(iv); }, 40);
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
  if (selandoEtapa) return;   // ja avancou nesta etapa: ignora o reenvio da senha nos 700ms ate a
                              // proxima carta (o input nao-limpo bateria na etapa nova = "senha errada" espuria)
  const et = etapaObj();
  if (!et) return;
  primarAudio();   // digitar a senha tambem serve de 1o gesto: destrava o som da cerimonia
  const tentativa = normalizar($('senha-input').value);
  if (tentativa !== normalizar(et.senha_desbloqueio)) {
    $('senha-erro').textContent = et.codigo_no_local ? (TEXTOS.codigo_errado || TEXTOS.senha_desbloqueio_errada) : TEXTOS.senha_desbloqueio_errada;
    $('senha-input').focus();
    $('senha-input').select();
    return;
  }
  avancarEtapa();
}

// Nucleo do avanco: usado pela senha (reserva), pela foto ENVIADA e pela chegada por GPS.
// Guarda contra reentrancia, porque o GPS reavalia a cada fix e nao pode avancar duas vezes.
function avancarEtapa() {
  const et = etapaObj();
  if (!et || selandoEtapa) return;
  selandoEtapa = true;
  if (etapaInicioTs) temposEtapa[et.id] = Date.now() - etapaInicioTs; // quanto durou esta etapa
  if (!cerimoniaFeita) cerimoniaChegada(); // se o GPS nao pegou, a cerimonia (item + som) sai aqui
  const revela = et.revela;                // o spoiler da recompensa, mostrado ao cumprir a missao
  etapaAtual++;
  salvarEstado();
  empurrarSincronia(); // avisa a sala; os outros celulares revelam a nova carta
  if (etapaAtual > rotaAtiva.etapas.length) { if (revela) mostrarSussurro(revela, null, 14000); mostrarFinal(); return; }
  toast(TEXTOS.etapa_avancou);
  // o mapa se preenche: carimba a etapa recém-cumprida e a câmera voa até ela (o "achei")
  desenharCarimbos(true);
  const corrFeita = rotaAtiva.etapas[etapaAtual - 2].corredor;
  if (mapa && corrFeita && corrFeita.length) {
    const alvo = corrFeita[corrFeita.length - 1];
    setTimeout(() => { mapa.invalidateSize(); voarPara(alvo, Math.max(mapa.getZoom(), CONFIG.zoom.inicial), 1.1); }, 160);
  }
  if (revela) setTimeout(() => mostrarSussurro(revela, null, 14000), 950); // quando a nova carta ja entrou
  setTimeout(entrarEtapa, 700); // deixa o carimbo estampar antes de trocar a carta
}

function mostrarFinal() {
  // a ultima selagem pode ter disparado a cerimonia de chegada: tira o card do item, o flash
  // dourado e o diamante do checkpoint de cima da tela final (senao ficam ~3,4s por cima)
  limparCerimoniaItem();   // encerra som/pisca/fechamento da cerimonia, senao rodam por cima da tela final
  $('item-ganho').classList.remove('visivel');
  $('item-ganho').classList.add('oculto');
  $('flash-cerimonia').classList.remove('pisca');
  $('flash-cerimonia').classList.add('oculto');
  limparAlvo();
  pararCronometro();
  pararTrilha();   // fim do jogo: a trilha de fundo some
  $('cronometro').classList.add('oculto');
  consultarRevelacao();   // se houve traidor na sala, a tela final de TODOS ganha a ultima verdade
  // o jogo acabou: encerra o GPS (watchPosition) e a sincronia de 35s, que seguiriam rodando
  if (watchId !== null && 'geolocation' in navigator) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  clearInterval(syncTimer); syncTimer = null;
  sala = null;   // sem sala, puxarSincronia sai cedo: o visibilitychange nao consulta mais o servidor após o fim
  $('final-seita').textContent = rotaAtiva.seita;
  const ff = $('final-foto');
  if (ff) {
    const src = rotaAtiva.foto_final || 'img/etapas/fariseus-final-b-patio-shuk.jpg';
    ff.src = src; ff.classList.remove('oculto'); ff.onerror = () => ff.classList.add('oculto');
  }
  $('final-convergencia').textContent = TEXTOS.convergencia;
  $('final-convergencia').classList.add('oculto');
  const frag = rotaAtiva.fragmento_final;
  const blocos = Array.isArray(frag) ? frag : [{ voz: 'gamliel', texto: frag || '' }];
  $('final-prosseguir').textContent = TEXTOS.prosseguir;
  iniciarFluxo('final', blocos, {
    fluxo: $('final-fluxo'), pontos: $('final-pontos'), botao: $('final-prosseguir'), voltar: $('final-voltar'),
  }, {
    rotuloProsseguir: TEXTOS.prosseguir,
    rotuloFim: TEXTOS.botao_entendido || 'Fim',
    aoFim: () => { $('final-convergencia').classList.remove('oculto'); $('final-prosseguir').classList.add('oculto'); $('final-voltar').classList.add('oculto'); },
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
  const ctrl = new AbortController();
  const tmo = setTimeout(() => ctrl.abort(), 10000);   // rede zumbi (conecta e nao responde) nao pendura a sincronia
  let r;
  try {
    r = await fetch(SB_URL + '/rest/v1/rpc/' + nome, {
      method: 'POST',
      headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + SB_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo), signal: ctrl.signal,
    });
  } finally { clearTimeout(tmo); }
  if (!r.ok) throw new Error('rpc ' + nome + ' ' + r.status);
  // RPC "returns void" (scouting ponto/foto) responde 204 sem corpo: r.json() num corpo
  // vazio rejeita e derrubava a sincronia. As RPC do jogo respondem 200 com JSON e seguem
  // parseando igual (via r.text() + JSON.parse).
  if (r.status === 204) return null;
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function iniciarSincronia() {
  if (!rotaAtiva || window.SOLO) return; // modo solo: fica fora da sala compartilhada
  if (!grupoAtivo) return;               // sem equipe definida (nao deveria acontecer fora do solo): fica local
  // a sala e a EQUIPE dentro da rota: rota + codigo. Assim cada equipe (e cada dia/evento,
  // com codigo novo) tem sala propria; um grupo novo nunca herda a etapa alta de outro.
  sala = normalizar(rotaAtiva.id + grupoAtivo);
  rpcSup('peula_entrar', { p_sala: sala, p_corrente: rotaAtiva.id })
    .then((r) => aplicarSincronia(r && r[0] && r[0].etapa)).catch(() => {});
  registrarJogador();
  setTimeout(consultarPapel, 3000);   // da tempo do registro chegar antes da 1a consulta
  clearInterval(syncTimer);
  syncTimer = setInterval(puxarSincronia, SYNC_MS);
}

function puxarSincronia() {
  if (!sala || sincronizando) return;
  sincronizando = true;
  rpcSup('peula_estado', { p_sala: sala })
    .then((r) => aplicarSincronia(r && r[0] && r[0].etapa))
    .catch(() => {})
    .then(() => {
      sincronizando = false;
      registrarJogador();        // best-effort: se o registro falhou antes, tenta no pulso
      consultarPapel();          // enquanto o sorteio nao sai, re-pergunta a cada pulso
      reenviarPontosTraidor();   // pontos batidos sem rede sobem quando ela volta
    });
}

function empurrarSincronia() {
  if (!sala) return;
  rpcSup('peula_avancar', { p_sala: sala, p_para: etapaAtual }).catch(() => {});
}

// Recebe a etapa do servidor. Se o grupo avançou, revela a(s) nova(s) carta(s) — mas
// com rede de segurança: nunca arranca quem ainda está no portão, na leitura de abertura
// ou no gate, nem teleporta um aparelho recém-chegado (ainda sem progresso local). Na
// sala compartilhada por senha, é isso que impede um grupo novo de herdar a etapa alta
// e cair direto no final. (A raiz, a chave da sala, se resolve no passo do código de grupo.)
function aplicarSincronia(etapaServidor) {
  if (!etapaServidor || !rotaAtiva || etapaServidor <= etapaAtual) return;
  const foraDoJogo = $('tela-portao').classList.contains('ativa') || $('tela-grupo').classList.contains('ativa') || $('tela-abertura').classList.contains('ativa');
  const semProgresso = etapaAtual <= 1 && inventario.length === 0 && !cerimoniaFeita;
  if (aguardandoGate || foraDoJogo || semProgresso) return;
  oferecerAvanco(etapaServidor);
}

// Aplica de fato o avanço vindo do grupo: revela a nova carta (ou vai ao final).
function aplicarEtapaDoGrupo(etapaServidor) {
  const total = rotaAtiva.etapas.length;
  etapaAtual = Math.min(etapaServidor, total + 1);
  salvarEstado();
  if (etapaAtual > total) { mostrarFinal(); toast('O caminho chegou ao fim.'); return; }
  desenharCarimbos();
  toast('Uma nova carta chegou.');
  entrarEtapa();
}

// ---------- avançar por convite (o grupo seguiu; o jogador decide ir junto) ----------
// Em vez de teleportar quando a sala avança, o app convida ("vamos juntos?"). Guarda a
// etapa pendente; o jogador aceita agora, adia (uma pílula discreta fica no topo) ou
// alcança o grupo jogando por conta própria (aí o convite se resolve sozinho, sem pulo).
function oferecerAvanco(etapaServidor) {
  if (etapaServidor <= etapaAtual || etapaServidor <= etapaPendente) return; // ja convidado (ou ja alcancado)
  etapaPendente = etapaServidor;
  mostrarConviteGrupo();
}

function alvoConvite() {
  const total = rotaAtiva ? rotaAtiva.etapas.length : 0;
  return Math.min(etapaPendente, total + 1);
}

// texto do alvo, com {n} trocado pela etapa; usa a chave "final" quando o grupo terminou.
function textoConvite(chaveNormal, chaveFinal, padraoNormal, padraoFinal) {
  const total = rotaAtiva ? rotaAtiva.etapas.length : 0;
  if (etapaPendente > total) return TEXTOS[chaveFinal] || padraoFinal;
  return (TEXTOS[chaveNormal] || padraoNormal).replace('{n}', alvoConvite());
}

function mostrarConviteGrupo() {
  if (!etapaPendente) return;
  $('convite-texto').textContent = textoConvite(
    'convite_texto', 'convite_final',
    'O grupo rompeu o selo e seguiu para a etapa {n}. Vão com eles?',
    'O grupo chegou ao fim do caminho. Vão encontrá-los?'
  );
  $('convite-grupo').classList.remove('oculto');
  $('ir-grupo').classList.add('oculto'); // com o card aberto, a pílula some
}

function aceitarAvanco() {
  const alvo = etapaPendente;
  etapaPendente = 0;
  $('convite-grupo').classList.add('oculto');
  $('ir-grupo').classList.add('oculto');
  if (alvo > etapaAtual) aplicarEtapaDoGrupo(alvo);
}

function recusarAvanco() {
  $('convite-grupo').classList.add('oculto');
  atualizarPilulaGrupo(); // vira uma pílula discreta no topo, pra ir quando quiser
}

function atualizarPilulaGrupo() {
  const pilula = $('ir-grupo');
  if (!pilula) return;
  const cardAberto = !$('convite-grupo').classList.contains('oculto');
  const temPendencia = etapaPendente > etapaAtual;
  if (temPendencia && !cardAberto) {
    $('ir-grupo-texto').textContent = textoConvite(
      'ir_grupo', 'ir_grupo_final',
      'O grupo está na etapa {n}', 'O grupo chegou ao fim'
    );
  }
  pilula.classList.toggle('oculto', !temPendencia || cardAberto);
}

// ao entrar em qualquer etapa: se o jogador alcançou (ou passou) a etapa pendente por
// conta própria, o convite se resolve; senão, mantém a pílula coerente com o estado.
function sincronizarConvite() {
  if (etapaPendente && etapaPendente <= etapaAtual) {
    etapaPendente = 0;
    $('convite-grupo').classList.add('oculto');
  }
  atualizarPilulaGrupo();
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
  if (aguardandoGate) verificarChegadaGate();  // chegou ao portao inicial pelo GPS: abre a 1a etapa
  verificarPontosTraidor();                    // so faz algo no celular do traidor
  if (bussolaAtiva) atualizarBussola();         // a agulha segue a posicao
  if (window.ADM && admModoTeste) admAtualizarTeste(); // no teste, o HUD acompanha a posicao
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
  verificarBeats(et);   // pops de historia no caminho (uma vez cada), seja qual for o avanco
  const dist = distanciaAoCorredorM(posAtual, et.corredor);
  const folga = Math.min(posAtual.acc || 0, 30);
  const dentro = dist <= (et.raio_m || 50) + folga;
  // cerimonia de chegada: perto do FIM do corredor (o checkpoint). Usa raio_chegada_m, o raio
  // PEQUENO (25-30m), e nao o raio_m largo do "no caminho": corrige o P1-1 (cerimonia precoce).
  const fim = (et.corredor && et.corredor.length) ? et.corredor[et.corredor.length - 1] : null;
  const raioCheg = (et.raio_chegada_m || et.raio_m || 50);
  const chegouAoFim = fim && distanciaAoCorredorM(posAtual, [fim]) <= raioCheg + folga;
  if (!cerimoniaFeita && chegouAoFim) cerimoniaChegada();
  // avanco automatico por GPS: so quando a etapa avanca pela CHEGADA (avanco "gps", ou "video"
  // depois do "ja gravamos"). Foto e codigo avancam pela foto/pelo codigo, nao pela chegada.
  if (chegouAoFim && chegadaGpsAvanca(et)) { avancarEtapa(); return; }
  if (dentro) {
    if (origem === 'botao') toast(TEXTOS.no_caminho);
  } else {
    const agora = Date.now();
    if (origem === 'auto' && agora - ultimoAvisoAutoTs < COOLDOWN_AVISO_AUTO_MS) return;
    if (origem === 'auto') ultimoAvisoAutoTs = agora;
    // na entrada da etapa (e na E1 logo apos o gate) o grupo ainda nao andou: nao avisa nada.
    // O texto de "fora do caminho" pressupoe que erraram uma virada, o que e falso aqui (acabaram
    // de chegar), e o modal roubava o foco. O auto (10min) e o botao cobrem quando o rumo importa.
    if (origem === 'entrada') return;
    clearTimeout(toastTimer);
    $('toast').classList.remove('visivel');
    $('aviso-texto').textContent = TEXTOS.fora_do_caminho;
    $('aviso').classList.remove('oculto');
    $('aviso-fechar').focus();
  }
  atualizarPainelDebug(dist);
}

// a etapa avanca sozinha ao chegar no checkpoint? So no avanco por GPS puro, ou no video ja gravado
function chegadaGpsAvanca(et) {
  if (!et) return false;
  if (et.avanco === 'gps') return true;
  if (et.avanco === 'video') return jaGravou;   // "ja gravamos" libera a chegada da ultima etapa
  return false;
}

// ---------- voo de câmera (respeita prefers-reduced-motion) ----------
// flyTo/flyToBounds IGNORAM animate:false; no "reduzir movimento" ramificamos para
// setView/fitBounds sem animação, senão a câmera voa mesmo com o sistema pedindo parar.
function reduzMovimento() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch (e) { return false; }
}
// Se o mapa estiver 0x0 (o _size do Leaflet zera por um instante numa troca de tela/painel),
// o flyTo/flyToBounds calcula sobre tamanho zero e estoura "Invalid LatLng (NaN, NaN)".
// Sem tamanho valido, ou no "reduzir movimento", vamos direto sem animacao.
function mapaSemTamanho() {
  if (!mapa) return true;
  try { const s = mapa.getSize(); return !s || !s.x || !s.y; } catch (e) { return true; }
}
function voarPara(latlng, zoom, duracao) {
  if (!mapa) return;
  const z = (zoom != null) ? zoom : mapa.getZoom();
  if (reduzMovimento() || mapaSemTamanho()) mapa.setView(latlng, z, { animate: false });
  else mapa.flyTo(latlng, z, { duration: (duracao != null ? duracao : 1.0) });
}
function voarParaBounds(bounds, duracao) {
  if (!mapa) return;
  if (reduzMovimento() || mapaSemTamanho()) mapa.fitBounds(bounds, { animate: false });
  else mapa.flyToBounds(bounds, { duration: (duracao != null ? duracao : 0.8) });
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
    html: '<div class="carimbo-hit"><div class="carimbo' + (novo ? ' carimbo-novo' : '') + '">' + n + '</div></div>',
    iconSize: [44, 44], iconAnchor: [22, 22],
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
  if (alvo) voarPara(alvo, Math.max(mapa.getZoom(), CONFIG.zoom.inicial), 1.0);
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
    '<div class="linha"><span id="dbg-tempos">tempos: -</span></div>' +
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
    ajustarMapaAoPainel(); // recomputa o bottom inline do mapa/controles com a nova altura do debug
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
  const t = $('dbg-tempos');
  if (t) {
    const ids = Object.keys(temposEtapa);
    t.textContent = 'tempos: ' + (ids.length ? ids.map(id => 'E' + id + ' ' + formatarTempo(temposEtapa[id])).join('  ') : '-');
  }
  const j = $('dbg-json');
  if (j) j.textContent = jsonCantos();
}

// ---------- modo ADM: diario de scouting (foto + comentario + etiqueta por ponto) ----------
// Abre no mapa da rota fariseus (referencia visual). Toque no mapa OU "marcar aqui (GPS)"
// cria um ponto e abre o editor: tirar/anexar fotos, escrever o comentario e por uma
// etiqueta (virada, marco, missao, cuidado, nota). Serve para levantar as rotas novas
// (e refinar E5/E6 da fariseus) em campo, com o material rico para montar o rotas.json.
//
// LOCAL-FIRST, nunca perde trabalho: os pontos e as fotos vivem no IndexedDB do aparelho
// (fotos sao pesadas demais para o localStorage). Reiniciar o telefone, fechar o Safari
// ou ficar sem sinal no meio do levantamento nao apaga nada. Ao reabrir, tudo volta.
// A foto e comprimida (lado maior ~1600px, JPEG) para caber muitas e para a sincronizacao
// futura com o servidor ser leve. Exportar junta tudo num texto + as fotos para compartilhar.
const ADM_DB = 'peula68adm';
const ADM_DB_VER = 1;
const ADM_ETIQUETAS = [
  { id: 'diamante', nome: 'Diamante', cor: '#2f9fc4' }, // chegada / checkpoint de etapa
  { id: 'virada', nome: 'Virada', cor: '#d98a2b' },     // onde o caminho vira
  { id: 'perdeu', nome: 'Se perdeu', cor: '#c0392b' },  // dica de recuperacao (se chegou aqui, errou)
  { id: 'cuidado', nome: 'Cuidado', cor: '#e8c020' },   // engana, perigo, nao entrar
  { id: 'missao', nome: 'Missão', cor: '#8e44ad' },     // ponto de foto / video / desafio
  { id: 'nota', nome: 'Nota', cor: '#5a8a3a' },         // observacao solta
];
const CHAVE_ADM_ROTA = 'peula68_adm_rota';    // nome da rota ativa no ADM
const CHAVE_ADM_ROTAS = 'peula68_adm_rotas';  // lista de nomes de rotas criadas

let admPontos = [];        // TODOS os pontos (de todas as rotas); a rota fica em p.rota
let admFotos = {};         // { ponto_id: [{id,ponto_id,thumb,criado_em,sincronizado}] } (thumb dataURL; blob so no IDB)
let admMarcadores = {};    // { ponto_id: L.marker } (so os da rota ativa)
let admLinhaRota = null;   // a trilha dourada que liga os pontos da rota ativa na ordem
let admDb = null;
let admEditandoId = null;
let admRotaAtiva = '';     // nome da rota sendo levantada (ex.: "Tapuz A")
let admModoTeste = false;  // "testar a rota": segue no mapa com o GPS, sem editar

function admUuid() {
  try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
  return 'p' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8);
}
function admCorEtiqueta(id) { const e = ADM_ETIQUETAS.find(x => x.id === id); return e ? e.cor : null; }
function admNomeEtiqueta(id) { const e = ADM_ETIQUETAS.find(x => x.id === id); return e ? e.nome : ''; }

// ----- rotas: cada levantamento e uma rota nomeada; os pontos ficam em p.rota -----
function admLerRotas() { try { return JSON.parse(localStorage.getItem(CHAVE_ADM_ROTAS)) || []; } catch (e) { return []; } }
function admSalvarRotas(lista) { try { localStorage.setItem(CHAVE_ADM_ROTAS, JSON.stringify(lista)); } catch (e) {} }
function admSalvarRotaAtiva() { try { localStorage.setItem(CHAVE_ADM_ROTA, admRotaAtiva); } catch (e) {} }
function admTodasRotas() { return admLerRotas(); }
// os pontos de uma rota (a ativa por padrao), na ordem (n)
function admPontosDaRota(rota) {
  const r = rota != null ? rota : admRotaAtiva;
  return admPontos.filter(p => (p.rota || '') === r).sort((a, b) => (a.n || 0) - (b.n || 0));
}
// garante que a rota exista na lista salva
function admGarantirRota(nome) {
  const lista = admLerRotas();
  if (!lista.includes(nome)) { lista.push(nome); admSalvarRotas(lista); }
}

function copiar(t, okMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => toast(okMsg)).catch(() => toast(t, 9000));
  else toast(t, 9000);
}

// ----- IndexedDB: pontos (metadados) e fotos (blobs) -----
function admAbrirDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('sem indexedDB')); return; }
    const req = indexedDB.open(ADM_DB, ADM_DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pontos')) db.createObjectStore('pontos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('fotos')) {
        const s = db.createObjectStore('fotos', { keyPath: 'id' });
        s.createIndex('ponto_id', 'ponto_id', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('erro ao abrir o banco'));
  });
}
function admPut(store, obj) {
  return new Promise((resolve, reject) => {
    const tx = admDb.transaction(store, 'readwrite');
    tx.objectStore(store).put(obj);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function admGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = admDb.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
function admGet(store, id) {
  return new Promise((resolve, reject) => {
    const req = admDb.transaction(store, 'readonly').objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
function admDelete(store, id) {
  return new Promise((resolve, reject) => {
    const tx = admDb.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function iniciarAdm() {
  window.ADM = true; // no adm nao roda a verificacao automatica de caminho (nada de aviso modal)
  rotaAtiva = ROTAS.rotas.find(r => r.id === 'fariseus') || ROTAS.rotas[0];
  if (!mapa) montarMapa();
  iniciarGeolocalizacao();
  mostrarTela('jogo');
  $('painel').classList.add('oculto');
  $('controles-flutuantes').classList.add('oculto');
  $('header-texto').textContent = 'ADM · diário de scouting';
  $('selo-seita').style.background = '#d4a017';
  document.documentElement.style.setProperty('--painel-alt', '0px');
  mapa.on('click', (e) => admNovoPonto(e.latlng.lat, e.latlng.lng, null));
  montarPainelAdm();
  montarEditorAdm();
  montarPistasAdm();
  window.addEventListener('online', () => admAtualizarBotaoSync());
  window.addEventListener('offline', () => admAtualizarBotaoSync());
  try {
    admDb = await admAbrirDb();
    await admMigrarAntigo();  // importa os pontos do formato antigo (localStorage), uma vez
    await admCarregar();
  } catch (e) {
    toast('Sem armazenamento neste navegador: os pontos vão sumir ao recarregar. Exporte antes de fechar.', 8000);
  }
  setTimeout(() => mapa.invalidateSize(), 80);
}

// traz o que ja estava no aparelho (fotos + pontos), desenha e lista
async function admCarregar() {
  admPontos = await admGetAll('pontos');
  const fotos = await admGetAll('fotos');
  admFotos = {};
  fotos.forEach(f => {
    (admFotos[f.ponto_id] = admFotos[f.ponto_id] || []).push({ id: f.id, ponto_id: f.ponto_id, thumb: f.thumb, criado_em: f.criado_em, sincronizado: f.sincronizado });
  });
  await admDefinirRotaInicial();   // decide a rota ativa e adota pontos sem rota
  admAtualizarSeletorRotas();
  admRedesenhar();
  admRenderLista();
  const daRota = admPontosDaRota();
  if (daRota.length && mapa) mapa.panTo([daRota[daRota.length - 1].lat, daRota[daRota.length - 1].lng]);
  if (admPontos.length) toast(admPontos.length + ' ponto(s) no aparelho.', 3500);
}

// decide a rota ativa (a salva, ou a 1a existente, ou cria uma) e adota pontos orfaos
async function admDefinirRotaInicial() {
  let rotas = admLerRotas();
  Array.from(new Set(admPontos.map(p => p.rota).filter(Boolean))).forEach(r => { if (!rotas.includes(r)) rotas.push(r); });
  if (!rotas.length) rotas = ['Rota 1'];
  admSalvarRotas(rotas);
  let salva = '';
  try { salva = localStorage.getItem(CHAVE_ADM_ROTA) || ''; } catch (e) {}
  admRotaAtiva = rotas.includes(salva) ? salva : rotas[0];
  admSalvarRotaAtiva();
  const orfaos = admPontos.filter(p => !p.rota);   // pontos do formato antigo, sem rota
  for (const p of orfaos) { p.rota = admRotaAtiva; await admPut('pontos', p); }
}

// limpa e redesenha o mapa com SO os pontos da rota ativa, mais a linha que os liga
function admRedesenhar() {
  if (!mapa) return;
  Object.values(admMarcadores).forEach(m => mapa.removeLayer(m));
  admMarcadores = {};
  admPontosDaRota().forEach(admDesenharMarcador);
  admDesenharLinhaRota();
}

// a trilha dourada que liga os pontos da rota ativa na ordem (mesmo visual do jogo)
function admDesenharLinhaRota() {
  if (admLinhaRota) { mapa.removeLayer(admLinhaRota); admLinhaRota = null; }
  const pts = admPontosDaRota().map(p => [p.lat, p.lng]);
  if (pts.length < 2) return;
  const g = L.layerGroup();
  L.polyline(pts, { color: '#ffcf5e', weight: 11, opacity: 0.16, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(g);
  L.polyline(pts, { color: '#ffe9a8', weight: 3, opacity: 0.85, dashArray: '1 9', lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(g);
  admLinhaRota = g.addTo(mapa);
}

// migracao unica: pontos do coletor antigo (localStorage, so lat/lng) viram pontos do diario
async function admMigrarAntigo() {
  let antigos = [];
  try { antigos = JSON.parse(localStorage.getItem(CHAVE_ADM)) || []; } catch (e) {}
  if (!antigos.length) return;
  const jaTem = await admGetAll('pontos');
  if (jaTem.length) { try { localStorage.removeItem(CHAVE_ADM); } catch (e) {} return; }
  const agora = new Date().toISOString();
  for (let i = 0; i < antigos.length; i++) {
    const a = antigos[i];
    if (typeof a.lat !== 'number' || typeof a.lng !== 'number') continue;
    await admPut('pontos', { id: admUuid(), n: i + 1, lat: a.lat, lng: a.lng, acc: null, nota: '', etiqueta: '', criado_em: agora, atualizado_em: agora, sincronizado: false });
  }
  try { localStorage.removeItem(CHAVE_ADM); } catch (e) {}
}

function admProximoN() {
  return admPontosDaRota().reduce((mx, p) => Math.max(mx, p.n || 0), 0) + 1;   // numeracao por rota
}

async function admNovoPonto(lat, lng, acc) {
  if (!admDb) { toast('Armazenamento indisponível neste navegador.'); return; }
  if (admModoTeste) return;   // no modo teste, tocar no mapa nao cria ponto
  const agora = new Date().toISOString();
  const p = {
    id: admUuid(), n: admProximoN(), lat, lng,
    acc: (acc != null ? acc : (posAtual && posAtual.acc) || null),
    nota: '', etiqueta: '', rota: admRotaAtiva,
    criado_em: agora, atualizado_em: agora, sincronizado: false,
  };
  admPontos.push(p);
  await admPut('pontos', p);
  admRedesenhar();
  admRenderLista();
  admAbrirEditor(p.id);
}

function admDesenharMarcador(p) {
  if (admMarcadores[p.id]) { mapa.removeLayer(admMarcadores[p.id]); }
  const cor = admCorEtiqueta(p.etiqueta);
  const temFoto = (admFotos[p.id] || []).length > 0;
  const diamante = p.etiqueta === 'diamante';
  const cls = 'pino-adm' + (cor ? ' etiquetado' : '') + (temFoto ? ' com-foto' : '') + (diamante ? ' pino-diamante' : '');
  const estilo = cor ? 'style="background:' + cor + '"' : '';
  const ic = L.divIcon({
    className: '',
    html: '<div class="' + cls + '" ' + estilo + '><span>' + p.n + '</span></div>',
    iconSize: diamante ? [32, 32] : [28, 28],
    iconAnchor: diamante ? [16, 16] : [14, 14],
  });
  const m = L.marker([p.lat, p.lng], { icon: ic, zIndexOffset: diamante ? 850 : 800 }).addTo(mapa);
  m.on('click', () => { if (admModoTeste) { mapa.panTo([p.lat, p.lng]); } else { admAbrirEditor(p.id); } });
  m.bindTooltip('#' + p.n + (p.etiqueta ? ' · ' + admNomeEtiqueta(p.etiqueta) : ''), { direction: 'top', offset: [0, -14] });
  admMarcadores[p.id] = m;
}

// ----- fotos: comprime, guarda blob no IDB, thumb na memoria -----
function admComprimirFoto(file, maxLado, q) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * escala)), h = Math.max(1, Math.round(img.height * escala));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob(b => b ? resolve(b) : reject(new Error('sem blob')), 'image/jpeg', q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('imagem inválida')); };
    img.src = url;
  });
}
function admThumbDataURL(blob, lado) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const escala = Math.min(1, lado / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * escala)), h = Math.max(1, Math.round(img.height * escala));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.6));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('thumb falhou')); };
    img.src = url;
  });
}

async function admAdicionarFotos(pontoId, fileList) {
  const files = Array.from(fileList || []).filter(f => f && f.type && f.type.indexOf('image') === 0);
  if (!files.length) return;
  toast(files.length > 1 ? 'Processando ' + files.length + ' fotos...' : 'Processando a foto...', 3000);
  for (const file of files) {
    try {
      const blob = await admComprimirFoto(file, 1600, 0.72);
      const thumb = await admThumbDataURL(blob, 240);
      const foto = { id: admUuid(), ponto_id: pontoId, blob, thumb, criado_em: new Date().toISOString(), sincronizado: false };
      await admPut('fotos', foto);
      (admFotos[pontoId] = admFotos[pontoId] || []).push({ id: foto.id, ponto_id: pontoId, thumb, criado_em: foto.criado_em, sincronizado: false });
    } catch (e) { toast('Uma foto não pôde ser lida. Tente de novo.'); }
  }
  await admTocarPonto(pontoId);
  admRedesenhar();   // o pino ganha o anel de "tem foto"
  admRenderEditor();
  admRenderLista();
}

async function admRemoverFoto(fotoId, pontoId) {
  await admDelete('fotos', fotoId);
  admFotos[pontoId] = (admFotos[pontoId] || []).filter(f => f.id !== fotoId);
  admRedesenhar();
  admRenderEditor();
  admRenderLista();
}

// marca o ponto como editado agora (mexeu em foto/nota/etiqueta): reabre a pendencia de sync
async function admTocarPonto(pontoId) {
  const p = admPontos.find(x => x.id === pontoId);
  if (!p) return;
  p.atualizado_em = new Date().toISOString();
  p.sincronizado = false;
  await admPut('pontos', p);
}

// ----- lista de pontos (painel de baixo) -----
function admRenderLista() {
  const l = $('adm-lista');
  if (!l) return;
  admAtualizarSeletorRotas();   // a contagem por rota no <select> acompanha marcar/apagar/limpar
  const pts = admPontosDaRota();
  if (!pts.length) { l.innerHTML = '<p class="adm-vazio">Rota "' + admEsc(admRotaAtiva) + '" ainda vazia. Toque no mapa onde tem algo, ou use o botão de baixo para marcar onde você está.</p>'; admAtualizarContagem(); return; }
  l.innerHTML = '';
  pts.forEach((p, idx) => {
    const fotos = admFotos[p.id] || [];
    const cor = admCorEtiqueta(p.etiqueta) || '#6b4a2a';
    const et = p.etiqueta ? '<span class="adm-chip" style="background:' + cor + '">' + admNomeEtiqueta(p.etiqueta) + '</span>' : '';
    const thumb = fotos.length ? '<img class="adm-card-thumb" src="' + fotos[0].thumb + '" alt="">' : '<span class="adm-card-thumb vazia">sem foto</span>';
    const nota = p.nota ? admEsc(p.nota) : '<i>sem comentário</i>';
    const extra = fotos.length > 1 ? '<span class="adm-card-mais">+' + (fotos.length - 1) + '</span>' : '';
    const card = document.createElement('div');
    card.className = 'adm-card' + (p.etiqueta === 'diamante' ? ' e-diamante' : '');
    card.innerHTML =
      '<span class="adm-card-n' + (p.etiqueta === 'diamante' ? ' n-diamante' : '') + '">' + p.n + '</span>' +
      '<span class="adm-card-thumb-wrap">' + thumb + extra + '</span>' +
      '<span class="adm-card-corpo">' + et + '<span class="adm-card-nota">' + nota + '</span>' +
      '<span class="adm-card-coord">' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + (p.sincronizado ? ' · <b class="ok">na nuvem</b>' : '') + '</span></span>' +
      '<span class="adm-card-ord">' +
        '<button type="button" class="adm-ord-btn" data-dir="-1"' + (idx === 0 ? ' disabled' : '') + ' aria-label="Subir">▲</button>' +
        '<button type="button" class="adm-ord-btn" data-dir="1"' + (idx === pts.length - 1 ? ' disabled' : '') + ' aria-label="Descer">▼</button>' +
      '</span>';
    ['.adm-card-n', '.adm-card-thumb-wrap', '.adm-card-corpo'].forEach(sel => card.querySelector(sel).addEventListener('click', () => admAbrirEditor(p.id)));
    card.querySelectorAll('.adm-ord-btn').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); admMoverPonto(p.id, Number(b.dataset.dir)); }));
    l.appendChild(card);
  });
  admAtualizarContagem();
}
function admEsc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function admAtualizarContagem() {
  const el = $('adm-contagem');
  if (!el) return;
  const pts = admPontosDaRota();
  const nFotos = pts.reduce((s, p) => s + (admFotos[p.id] || []).length, 0);
  const nSync = pts.filter(p => p.sincronizado).length;
  const nDia = pts.filter(p => p.etiqueta === 'diamante').length;
  el.textContent = pts.length + ' ponto(s) · ' + nDia + ' diamante(s) · ' + nFotos + ' foto(s) · ' + nSync + ' na nuvem';
  admAtualizarBotaoSync();
}

// ----- editor de um ponto (bottom sheet) -----
function montarPainelAdm() {
  const p = document.createElement('aside');
  p.id = 'painel-adm';
  p.innerHTML =
    '<div class="adm-cab">DIÁRIO DE SCOUTING<span>toque no mapa onde tem algo. Cada ponto guarda foto, comentário e etiqueta.</span></div>' +
    '<div class="adm-rota-barra">' +
      '<span class="adm-rota-lbl">Rota</span>' +
      '<select id="adm-rota-sel" aria-label="Rota ativa"></select>' +
      '<button id="adm-rota-nova" type="button" title="Nova rota" aria-label="Nova rota">＋</button>' +
      '<button id="adm-rota-ren" type="button" title="Renomear rota" aria-label="Renomear rota">✎</button>' +
    '</div>' +
    '<div id="adm-lista"></div>' +
    '<div id="adm-contagem" class="adm-contagem"></div>' +
    '<div class="adm-btns">' +
      '<button id="adm-gps" class="adm-forte">＋ marcar onde estou (GPS)</button>' +
    '</div>' +
    '<div class="adm-btns">' +
      '<button id="adm-pistas">pistas do jogo</button>' +
      '<button id="adm-testar">testar a rota</button>' +
      '<button id="adm-sync">sincronizar</button>' +
    '</div>' +
    '<div class="adm-btns">' +
      '<button id="adm-copiar">copiar anotações</button>' +
      '<button id="adm-exportar">exportar fotos</button>' +
      '<button id="adm-limpar">limpar</button>' +
    '</div>';
  document.body.appendChild(p);
  $('adm-rota-sel').addEventListener('change', (e) => admTrocarRota(e.target.value));
  $('adm-rota-nova').addEventListener('click', admNovaRota);
  $('adm-rota-ren').addEventListener('click', admRenomearRota);
  $('adm-pistas').addEventListener('click', admAbrirPistas);
  $('adm-testar').addEventListener('click', () => admToggleTeste());
  $('adm-gps').addEventListener('click', () => {
    if (!posAtual) { toast(TEXTOS.sem_gps); return; }
    admNovoPonto(posAtual.lat, posAtual.lng, posAtual.acc);
    if (mapa) mapa.panTo([posAtual.lat, posAtual.lng]);
  });
  $('adm-sync').addEventListener('click', () => admSincronizar(true));
  $('adm-copiar').addEventListener('click', admCopiarAnotacoes);
  $('adm-exportar').addEventListener('click', admExportarFotos);
  $('adm-limpar').addEventListener('click', admLimparTudo);
  // toque no titulo recolhe/expande o diario (pra ver o mapa por inteiro no campo)
  const cab = p.querySelector('.adm-cab');
  const aplicarMin = (min) => {
    p.classList.toggle('adm-min', min);
    try { localStorage.setItem('peula68_adm_min', min ? '1' : ''); } catch (e) {}
  };
  cab.addEventListener('click', () => aplicarMin(!p.classList.contains('adm-min')));
  try { if (localStorage.getItem('peula68_adm_min') === '1') aplicarMin(true); } catch (e) {}
}

// popula o <select> de rotas com as rotas conhecidas e marca a ativa
function admAtualizarSeletorRotas() {
  const sel = $('adm-rota-sel');
  if (!sel) return;
  const rotas = admTodasRotas();
  sel.innerHTML = '';
  rotas.forEach(r => {
    const o = document.createElement('option');
    o.value = r; o.textContent = r + ' (' + admPontosDaRota(r).length + ')';
    if (r === admRotaAtiva) o.selected = true;
    sel.appendChild(o);
  });
}

async function admTrocarRota(nome) {
  if (nome === admRotaAtiva) return;
  admGarantirRota(nome);
  admRotaAtiva = nome;
  admSalvarRotaAtiva();
  if (admModoTeste) admToggleTeste(false);   // sai do teste ao trocar de rota
  admAtualizarSeletorRotas();
  admRedesenhar();
  admRenderLista();
  const pts = admPontosDaRota();
  if (pts.length && mapa) voarPara([pts[pts.length - 1].lat, pts[pts.length - 1].lng], Math.max(mapa.getZoom(), CONFIG.zoom.inicial), 0.7);
  toast('Rota ativa: ' + nome + '.');
}

function admNovaRota() {
  const nome = (prompt('Nome da nova rota (ex.: Tapuz A):') || '').trim();
  if (!nome) return;
  if (admTodasRotas().includes(nome)) { toast('Já existe uma rota com esse nome.'); return; }
  admGarantirRota(nome);
  admTrocarRota(nome);
}

async function admRenomearRota() {
  const atual = admRotaAtiva;
  const novo = (prompt('Renomear a rota "' + atual + '" para:', atual) || '').trim();
  if (!novo || novo === atual) return;
  if (admTodasRotas().includes(novo)) { toast('Já existe uma rota com esse nome.'); return; }
  // atualiza os pontos dessa rota
  const pts = admPontosDaRota(atual);
  const agora = new Date().toISOString();
  for (const p of pts) {
    p.rota = novo;
    p.sincronizado = false;   // mudou a rota: reabre a pendencia de sync (servidor tem o nome antigo)
    p.atualizado_em = agora;
    await admPut('pontos', p);
  }
  // troca na lista salva
  const lista = admLerRotas().map(r => r === atual ? novo : r);
  if (!lista.includes(novo)) lista.push(novo);
  admSalvarRotas(lista);
  admRotaAtiva = novo;
  admSalvarRotaAtiva();
  admAtualizarSeletorRotas();
  admRenderLista();
  toast('Rota renomeada para ' + novo + '.');
}

// reordena um ponto na sequencia da rota (troca de posicao com o vizinho e renumera)
async function admMoverPonto(id, dir) {
  const pts = admPontosDaRota();
  const i = pts.findIndex(p => p.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pts.length) return;
  const a = pts[i], b = pts[j];
  const tmp = a.n; a.n = b.n; b.n = tmp;
  a.atualizado_em = b.atualizado_em = new Date().toISOString();
  a.sincronizado = b.sincronizado = false;
  await admPut('pontos', a);
  await admPut('pontos', b);
  admRedesenhar();
  admRenderLista();
}

function montarEditorAdm() {
  const ed = document.createElement('div');
  ed.id = 'adm-editor';
  ed.className = 'oculto';
  ed.innerHTML =
    '<div id="adm-ed-fundo" class="adm-ed-fundo"></div>' +
    '<div class="adm-ed-folha" role="dialog" aria-modal="true">' +
      '<div class="adm-ed-cab"><span id="adm-ed-titulo">Ponto</span>' +
        '<button id="adm-ed-fechar" type="button" aria-label="Fechar">✕</button></div>' +
      '<div class="adm-ed-fotos" id="adm-ed-fotos"></div>' +
      '<label class="adm-ed-addfoto"><span>＋ Foto (tirar ou escolher)</span>' +
        '<input id="adm-ed-input" type="file" accept="image/*" multiple hidden></label>' +
      '<label class="adm-ed-rot" for="adm-ed-nota">Comentário</label>' +
      '<textarea id="adm-ed-nota" rows="3" placeholder="O que é isto? Para onde vai, o que falar aqui, o que fotografar..."></textarea>' +
      '<div class="adm-ed-rot">Etiqueta</div>' +
      '<div class="adm-ed-etiquetas" id="adm-ed-etiquetas"></div>' +
      '<div class="adm-ed-coord" id="adm-ed-coord"></div>' +
      '<div class="adm-ed-btns">' +
        '<button id="adm-ed-gps" type="button">usar meu GPS aqui</button>' +
        '<button id="adm-ed-apagar" type="button">apagar ponto</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ed);

  $('adm-ed-fundo').addEventListener('click', admFecharEditor);
  $('adm-ed-fechar').addEventListener('click', admFecharEditor);
  $('adm-ed-input').addEventListener('change', (e) => { if (admEditandoId) admAdicionarFotos(admEditandoId, e.target.files); e.target.value = ''; });
  $('adm-ed-nota').addEventListener('input', admDebounceNota);
  $('adm-ed-gps').addEventListener('click', admAtualizarCoordDoPonto);
  $('adm-ed-apagar').addEventListener('click', admApagarPontoAtual);

  const cont = $('adm-ed-etiquetas');
  ADM_ETIQUETAS.forEach(e => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'adm-et-btn';
    b.dataset.et = e.id;
    b.textContent = e.nome;
    b.style.setProperty('--et-cor', e.cor);
    b.addEventListener('click', () => admDefinirEtiqueta(e.id));
    cont.appendChild(b);
  });
}

function admAbrirEditor(id) {
  admEditandoId = id;
  admRenderEditor();
  $('adm-editor').classList.remove('oculto');
  const p = admPontos.find(x => x.id === id);
  if (p && mapa) mapa.panTo([p.lat, p.lng]);
}
function admFecharEditor() {
  admEditandoId = null;
  $('adm-editor').classList.add('oculto');
}

function admRenderEditor() {
  const p = admPontos.find(x => x.id === admEditandoId);
  if (!p) { admFecharEditor(); return; }
  $('adm-ed-titulo').textContent = 'Ponto ' + p.n;
  const cont = $('adm-ed-fotos');
  const fotos = admFotos[p.id] || [];
  cont.innerHTML = '';
  if (!fotos.length) {
    cont.innerHTML = '<p class="adm-ed-semfoto">Nenhuma foto ainda.</p>';
  } else {
    fotos.forEach(f => {
      const cel = document.createElement('div');
      cel.className = 'adm-ed-foto';
      cel.innerHTML = '<img src="' + f.thumb + '" alt=""><button type="button" class="adm-ed-foto-x" aria-label="Remover foto">✕</button>';
      cel.querySelector('img').addEventListener('click', () => admVerFoto(f.id));
      cel.querySelector('.adm-ed-foto-x').addEventListener('click', () => { if (confirm('Remover esta foto?')) admRemoverFoto(f.id, p.id); });
      cont.appendChild(cel);
    });
  }
  const nota = $('adm-ed-nota');
  if (nota.value !== (p.nota || '')) nota.value = p.nota || '';
  $('adm-ed-etiquetas').querySelectorAll('.adm-et-btn').forEach(b => b.classList.toggle('ativa', b.dataset.et === p.etiqueta));
  $('adm-ed-coord').innerHTML = '<b>' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) + '</b>' + (p.acc != null ? ' <span>±' + Math.round(p.acc) + 'm</span>' : '');
}

// abre a foto em tamanho grande, lendo o blob do IDB (o lightbox do jogo, reaproveitado)
let admFotoUrlAtual = null;   // object URL aberto no lightbox ADM; revogado ao trocar de foto
async function admVerFoto(fotoId) {
  const f = await admGet('fotos', fotoId);
  if (!f || !f.blob) { toast('Foto não encontrada.'); return; }
  const g = $('foto-grande');
  if (admFotoUrlAtual) { URL.revokeObjectURL(admFotoUrlAtual); admFotoUrlAtual = null; } // reabrir rapido: revoga a anterior antes de trocar
  const url = URL.createObjectURL(f.blob);
  admFotoUrlAtual = url;
  if (g) {
    const soltar = () => { URL.revokeObjectURL(url); if (admFotoUrlAtual === url) admFotoUrlAtual = null; };
    g.onload = soltar;    // onload E onerror revogam: imagem quebrada nao deixa a URL vazando
    g.onerror = soltar;
    g.src = url;
  }
  $('tela-foto').classList.remove('oculto');
}

let admNotaTimer = null;
function admDebounceNota() {
  clearTimeout(admNotaTimer);
  const id = admEditandoId;
  const val = $('adm-ed-nota').value;
  admNotaTimer = setTimeout(async () => {
    const p = admPontos.find(x => x.id === id);
    if (!p) return;
    p.nota = val;
    await admTocarPonto(id);
    admRenderLista();
  }, 400);
}

async function admDefinirEtiqueta(etId) {
  const p = admPontos.find(x => x.id === admEditandoId);
  if (!p) return;
  p.etiqueta = (p.etiqueta === etId) ? '' : etId;  // tocar de novo tira a etiqueta
  await admTocarPonto(p.id);
  admRedesenhar();
  admRenderEditor();
  admRenderLista();
}

async function admAtualizarCoordDoPonto() {
  if (!posAtual) { toast(TEXTOS.sem_gps); return; }
  const p = admPontos.find(x => x.id === admEditandoId);
  if (!p) return;
  p.lat = posAtual.lat; p.lng = posAtual.lng; p.acc = posAtual.acc;
  await admTocarPonto(p.id);
  admRedesenhar();
  if (mapa) mapa.panTo([p.lat, p.lng]);
  admRenderEditor();
  admRenderLista();
  toast('Coordenada atualizada para a sua posição.');
}

async function admApagarPontoAtual() {
  const p = admPontos.find(x => x.id === admEditandoId);
  if (!p) return;
  if (!confirm('Apagar o ponto ' + p.n + ' e suas fotos?')) return;
  for (const f of (admFotos[p.id] || [])) await admDelete('fotos', f.id);
  delete admFotos[p.id];
  await admDelete('pontos', p.id);
  const rota = p.rota;
  admPontos = admPontos.filter(x => x.id !== p.id);
  await admRenumerarRota(rota);   // fecha o buraco na numeracao da rota
  admFecharEditor();
  admRedesenhar();
  admRenderLista();
}

// renumera 1..k os pontos de uma rota, na ordem atual (sem buracos)
async function admRenumerarRota(rota) {
  const pts = admPontosDaRota(rota);
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].n !== i + 1) {
      pts[i].n = i + 1;
      pts[i].sincronizado = false;   // mudou o numero: reabre a pendencia de sync (servidor tem o n antigo)
      pts[i].atualizado_em = new Date().toISOString();
      await admPut('pontos', pts[i]);
    }
  }
}

async function admLimparTudo() {
  const pts = admPontosDaRota();
  if (!pts.length) { toast('Rota vazia, nada para limpar.'); return; }
  if (!confirm('Apagar os ' + pts.length + ' pontos e fotos da rota "' + admRotaAtiva + '"? Só esta rota. Exporte antes se ainda não mandou.')) return;
  for (const p of pts) {
    for (const f of (admFotos[p.id] || [])) await admDelete('fotos', f.id);
    delete admFotos[p.id];
    await admDelete('pontos', p.id);
  }
  admPontos = admPontos.filter(p => (p.rota || '') !== admRotaAtiva);
  admFecharEditor();
  admRedesenhar();
  admRenderLista();
  toast('Rota "' + admRotaAtiva + '" limpa.');
}

// ----- exportar (sempre a rota ativa) -----
function admSlug(s) {
  return (s || 'rota').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24) || 'rota';
}
function admMarkdown() {
  const pts = admPontosDaRota();
  const linhas = ['# Scouting — rota: ' + (admRotaAtiva || '?'), ''];
  pts.forEach(p => {
    const et = p.etiqueta ? ' [' + admNomeEtiqueta(p.etiqueta) + ']' : '';
    const nf = (admFotos[p.id] || []).length;
    linhas.push('## Ponto ' + p.n + et);
    linhas.push('coord: [' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) + ']' + (p.acc != null ? ' (±' + Math.round(p.acc) + 'm)' : ''));
    if (p.nota) linhas.push(p.nota);
    linhas.push('fotos: ' + nf + (nf ? ' (arquivos ' + admSlug(admRotaAtiva) + '-p' + String(p.n).padStart(2, '0') + '-*.jpg)' : ''));
    linhas.push('');
  });
  return linhas.join('\n');
}

function admCopiarAnotacoes() {
  if (!admPontosDaRota().length) { toast('Rota vazia.'); return; }
  copiar(admMarkdown(), 'Anotações da rota copiadas. Cole no WhatsApp e me manda.');
}

// junta as fotos da rota ativa (blobs do IDB) + o texto e tenta compartilhar (WhatsApp/
// AirDrop); se o aparelho nao suportar compartilhar arquivos, baixa cada foto + o .md
async function admExportarFotos() {
  const pts = admPontosDaRota();
  if (!pts.length) { toast('Rota vazia.'); return; }
  toast('Preparando o pacote...', 4000);
  const slug = admSlug(admRotaAtiva);
  const arquivos = [];
  for (const p of pts) {
    const fotos = admFotos[p.id] || [];
    for (let i = 0; i < fotos.length; i++) {
      const f = await admGet('fotos', fotos[i].id);
      if (!f || !f.blob) continue;
      const nome = slug + '-p' + String(p.n).padStart(2, '0') + '-' + String.fromCharCode(97 + i) + '.jpg';
      arquivos.push(new File([f.blob], nome, { type: 'image/jpeg' }));
    }
  }
  const md = admMarkdown();
  arquivos.push(new File([md], slug + '-scouting.md', { type: 'text/markdown' }));

  if (navigator.canShare && navigator.canShare({ files: arquivos })) {
    try { await navigator.share({ files: arquivos, title: 'Scouting', text: md }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; /* cancelou: nao baixa */ }
  }
  // fallback: baixa tudo (um a um)
  arquivos.forEach((file, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, i * 350);  // espaça os downloads para o navegador não bloquear
  });
  toast('Baixando ' + arquivos.length + ' arquivo(s). No iPhone pode pedir permissão para vários downloads.', 7000);
}

// ----- sincronizacao com o servidor (Supabase, schema peula) -----
// LOCAL-FIRST + servidor: o coletor funciona 100% offline; sincronizar SO acontece
// quando o Allan toca no botao (nada de auto-upload gastando dados moveis caros em
// campo). Sobe os pontos primeiro (a foto tem FK para o ponto) e depois as fotos em
// base64, um por um, marcando cada um como sincronizado no IndexedDB. Idempotente:
// re-sincronizar so manda o que ainda falta. Sem sinal ou com erro, nada trava.
let admSincronizando = false;

function admDispId() {
  try {
    let d = localStorage.getItem('peula68_disp');
    if (!d) { d = admUuid(); localStorage.setItem('peula68_disp', d); }
    return d;
  } catch (e) { return 'anon'; }
}

function admBlobParaB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
    r.onerror = () => reject(r.error || new Error('leitura falhou'));
    r.readAsDataURL(blob);
  });
}

function admContarPendentes() {
  const p = admPontos.filter(x => !x.sincronizado).length;
  let f = 0;
  for (const k in admFotos) f += (admFotos[k] || []).filter(x => !x.sincronizado).length;
  return { p, f };
}

function admAtualizarBotaoSync(txtFixo) {
  const b = $('adm-sync');
  if (!b) return;
  if (txtFixo) { b.textContent = txtFixo; return; }
  if (!navigator.onLine) { b.textContent = 'sincronizar (sem internet)'; b.classList.remove('adm-sync-ok'); return; }
  const { p, f } = admContarPendentes();
  const pend = p + f;
  b.classList.toggle('adm-sync-ok', pend === 0 && admPontos.length > 0);
  b.textContent = pend === 0
    ? (admPontos.length ? 'tudo na nuvem ✓' : 'sincronizar')
    : 'sincronizar (' + p + ' ponto' + (p === 1 ? '' : 's') + ', ' + f + ' foto' + (f === 1 ? '' : 's') + ')';
}

async function admSincronizar(manual) {
  if (admSincronizando) return;
  if (!admDb) { if (manual) toast('Armazenamento indisponível.'); return; }
  if (!navigator.onLine) { if (manual) toast('Sem internet agora. Toque de novo quando pegar wifi.'); admAtualizarBotaoSync(); return; }
  const pendentesP = admPontos.filter(p => !p.sincronizado);
  let pendentesF = [];
  for (const k in admFotos) pendentesF = pendentesF.concat((admFotos[k] || []).filter(f => !f.sincronizado));
  if (!pendentesP.length && !pendentesF.length) { if (manual) toast('Tudo já está na nuvem.'); admAtualizarBotaoSync(); return; }

  admSincronizando = true;
  admAtualizarBotaoSync('enviando...');
  const disp = admDispId();
  let okP = 0, okF = 0, falhou = 0;
  try {
    for (const p of pendentesP) {
      try {
        await rpcSup('peula_scouting_ponto', {
          p_id: p.id, p_n: p.n, p_lat: p.lat, p_lng: p.lng, p_acc: p.acc,
          p_nota: p.nota || '', p_etiqueta: p.etiqueta || '', p_rota: p.rota || '', p_dispositivo: disp,
          p_criado_em: p.criado_em, p_atualizado_em: p.atualizado_em,
        });
        p.sincronizado = true;
        await admPut('pontos', p);
        okP++;
      } catch (e) { falhou++; }
    }
    for (const meta of pendentesF) {
      const ponto = admPontos.find(x => x.id === meta.ponto_id);
      if (!ponto || !ponto.sincronizado) continue;   // a foto tem FK: so sobe com o ponto ja no servidor
      try {
        const f = await admGet('fotos', meta.id);
        if (!f || !f.blob) continue;
        const b64 = await admBlobParaB64(f.blob);
        await rpcSup('peula_scouting_foto', { p_id: f.id, p_ponto_id: f.ponto_id, p_mime: (f.blob.type || 'image/jpeg'), p_dados_b64: b64 });
        f.sincronizado = true;
        await admPut('fotos', f);
        const arr = admFotos[f.ponto_id] || [];
        const m = arr.find(x => x.id === f.id); if (m) m.sincronizado = true;
        okF++;
      } catch (e) { falhou++; }
    }
  } finally {
    admSincronizando = false;
    admRenderLista();
    admAtualizarBotaoSync();
  }
  toast('Enviados: ' + okP + ' ponto(s), ' + okF + ' foto(s)' + (falhou ? ' · ' + falhou + ' ainda pendente(s)' : '. Tudo na nuvem.'), 6000);
}

// ----- modo "testar a rota": segue no mapa com o GPS, sem editar -----
// Reproduz a experiencia de quem vai andar a rota: a trilha desenhada, sua posicao
// ao vivo, a distancia ao diamante mais proximo e um botao para "voltar" a ele quando
// se perder. Tocar no mapa nao cria ponto aqui (admNovoPonto ignora no modo teste).
let admTesteHud = null;
let admTesteTimer = null;

function admDiamantes() { return admPontosDaRota().filter(p => p.etiqueta === 'diamante'); }

function admDiamanteMaisPerto() {
  if (!posAtual) return null;
  let melhor = null, dmin = Infinity;
  admDiamantes().forEach(d => {
    const dd = distanciaAoCorredorM(posAtual, [[d.lat, d.lng]]);
    if (dd < dmin) { dmin = dd; melhor = { ponto: d, dist: dd }; }
  });
  return melhor;
}

function admToggleTeste(forcar) {
  const novo = (forcar === undefined) ? !admModoTeste : !!forcar;
  if (novo === admModoTeste) return;
  const btn = $('adm-testar');
  if (novo) {
    if (!admPontosDaRota().length) { toast('Marque alguns pontos primeiro.'); return; }
    admModoTeste = true;
    admFecharEditor();
    if (btn) { btn.textContent = 'sair do teste'; btn.classList.add('adm-teste-on'); }
    $('painel-adm').classList.add('oculto');           // mapa grande durante o teste
    admMostrarHudTeste();
    admAtualizarTeste();
    admTesteTimer = setInterval(admAtualizarTeste, 2000);
    const pts = admPontosDaRota();
    if (mapa && pts.length) { setTimeout(() => { mapa.invalidateSize(); voarParaBounds(L.latLngBounds(pts.map(p => [p.lat, p.lng])).pad(0.25), 0.8); }, 60); }
    toast('Modo teste: siga a trilha dourada. O HUD mostra o diamante mais perto.', 5000);
  } else {
    admModoTeste = false;
    if (btn) { btn.textContent = 'testar a rota'; btn.classList.remove('adm-teste-on'); }
    $('painel-adm').classList.remove('oculto');
    clearInterval(admTesteTimer); admTesteTimer = null;
    if (admTesteHud) { admTesteHud.remove(); admTesteHud = null; }
    setTimeout(() => mapa && mapa.invalidateSize(), 60);
  }
}

function admMostrarHudTeste() {
  if (admTesteHud) return;
  const h = document.createElement('div');
  h.id = 'adm-teste-hud';
  h.innerHTML =
    '<div class="ath-linha"><b id="ath-prox">diamante mais perto</b><span id="ath-dist">· · ·</span></div>' +
    '<div class="ath-btns">' +
      '<button id="ath-voltar" type="button">◆ ir ao diamante</button>' +
      '<button id="ath-centrar" type="button">◎ onde estou</button>' +
      '<button id="ath-sair" type="button">✕ sair</button>' +
    '</div>';
  document.body.appendChild(h);
  admTesteHud = h;
  $('ath-voltar').addEventListener('click', () => {
    const d = admDiamanteMaisPerto();
    if (!d) { toast(posAtual ? 'Sem diamantes nesta rota.' : TEXTOS.sem_gps); return; }
    if (mapa) voarPara([d.ponto.lat, d.ponto.lng], Math.max(mapa.getZoom(), CONFIG.zoom.inicial + 1), 0.9);
    toast('Diamante #' + d.ponto.n + ' a ' + Math.round(d.dist) + ' m.');
  });
  $('ath-centrar').addEventListener('click', () => { if (posAtual && mapa) voarPara([posAtual.lat, posAtual.lng], Math.max(mapa.getZoom(), CONFIG.zoom.inicial), 0.6); else toast(TEXTOS.sem_gps); });
  $('ath-sair').addEventListener('click', () => admToggleTeste(false));
}

function admAtualizarTeste() {
  if (!admModoTeste || !admTesteHud) return;
  const prox = $('ath-prox'), dist = $('ath-dist');
  if (!admDiamantes().length) { if (prox) prox.textContent = 'sem diamantes nesta rota'; if (dist) dist.textContent = ''; return; }
  if (!posAtual) { if (prox) prox.textContent = 'esperando o GPS...'; if (dist) dist.textContent = '· · ·'; return; }
  const d = admDiamanteMaisPerto();
  if (!d) return;
  if (prox) prox.textContent = 'diamante #' + d.ponto.n + (d.ponto.nota ? ' · ' + d.ponto.nota.slice(0, 38) : '');
  if (dist) dist.textContent = d.dist < 1000 ? Math.round(d.dist) + ' m' : (d.dist / 1000).toFixed(1) + ' km';
}

// ----- pistas do jogo (so leitura): ver o que a rota fariseus manda enquanto marca -----
// Para refinar a fariseus em campo: le a rota do rotas.json e mostra, por etapa, as
// direcoes (numeradas), a missao e a senha. "corrigir" numa direcao marca um ponto no
// lugar (GPS ou centro do mapa) com a nota "corrigir EX.Y:" ja pronta para completar.
function montarPistasAdm() {
  const ov = document.createElement('div');
  ov.id = 'adm-pistas-ov';
  ov.className = 'oculto';
  ov.innerHTML =
    '<div id="adm-pistas-fundo" class="adm-ed-fundo"></div>' +
    '<div class="adm-pistas-folha" role="dialog" aria-modal="true">' +
      '<div class="adm-ed-cab"><span id="adm-pistas-titulo">Pistas do jogo</span>' +
        '<button id="adm-pistas-fechar" type="button" aria-label="Fechar">✕</button></div>' +
      '<p class="adm-pistas-dica">Só leitura, do que o jogo manda hoje. Toque em "corrigir" numa pista errada para marcar um ponto no lugar.</p>' +
      '<div id="adm-pistas-corpo"></div>' +
    '</div>';
  document.body.appendChild(ov);
  $('adm-pistas-fundo').addEventListener('click', admFecharPistas);
  $('adm-pistas-fechar').addEventListener('click', admFecharPistas);
}

function admRotaFariseus() { return (ROTAS && ROTAS.rotas) ? ROTAS.rotas.find(r => r.id === 'fariseus') : null; }

function admAbrirPistas() {
  const rota = admRotaFariseus();
  const corpo = $('adm-pistas-corpo');
  if (!rota || !corpo) { toast('Rota fariseus não encontrada no conteúdo.'); return; }
  $('adm-pistas-titulo').textContent = 'Pistas do jogo · ' + rota.seita;
  corpo.innerHTML = '';
  (rota.etapas || []).forEach((et, ei) => {
    const bloco = document.createElement('div');
    bloco.className = 'adm-pista-etapa';
    let html = '<h4>Etapa ' + et.id + (et.titulo ? ' · ' + admEsc(et.titulo) : '') + '</h4>';
    (et.direcoes || []).forEach((d, di) => {
      html += '<div class="adm-pista-dir"><span class="adm-pista-num">' + et.id + '.' + (di + 1) + '</span>' +
        '<span class="adm-pista-txt">' + admEsc(d) + '</span>' +
        '<button type="button" class="adm-pista-corr" data-et="' + ei + '" data-di="' + di + '">corrigir</button></div>';
    });
    if (et.missao) html += '<p class="adm-pista-extra"><b>Missão:</b> ' + admEsc(et.missao) + '</p>';
    if (et.senha_desbloqueio) html += '<p class="adm-pista-extra"><b>Senha:</b> ' + admEsc(et.senha_desbloqueio) + '</p>';
    bloco.innerHTML = html;
    bloco.querySelectorAll('.adm-pista-corr').forEach(b => b.addEventListener('click', () => admCorrigirDirecao(Number(b.dataset.et), Number(b.dataset.di))));
    corpo.appendChild(bloco);
  });
  const volta = document.createElement('button');
  volta.type = 'button';
  volta.className = 'adm-pistas-voltar';
  volta.textContent = '✕ voltar ao ADM';
  volta.addEventListener('click', admFecharPistas);
  corpo.appendChild(volta);
  $('adm-pistas-ov').classList.remove('oculto');
  const folha = document.querySelector('.adm-pistas-folha');
  if (folha) folha.scrollTop = 0;   // abre sempre do topo, com o cabecalho e o X a vista
}

function admFecharPistas() { const o = $('adm-pistas-ov'); if (o) o.classList.add('oculto'); }

async function admCorrigirDirecao(etIdx, dirIdx) {
  const rota = admRotaFariseus();
  if (!rota || !rota.etapas[etIdx]) return;
  const et = rota.etapas[etIdx];
  const rotulo = 'E' + et.id + '.' + (dirIdx + 1);
  admFecharPistas();
  let lat, lng, acc = null;
  if (posAtual) { lat = posAtual.lat; lng = posAtual.lng; acc = posAtual.acc; }
  else if (mapa) { const c = mapa.getCenter(); lat = c.lat; lng = c.lng; }
  else { toast('Sem posição para marcar.'); return; }
  await admNovoPonto(lat, lng, acc);   // cria na rota ativa e abre o editor
  const p = admPontos.find(x => x.id === admEditandoId);
  if (!p) return;
  p.nota = 'corrigir ' + rotulo + ': ';
  p.etiqueta = 'cuidado';
  await admPut('pontos', p);
  admRedesenhar();
  admRenderEditor();
  admRenderLista();
  const ta = $('adm-ed-nota');
  if (ta) { ta.value = p.nota; ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {} }
  toast('Ponto de correção ' + rotulo + ' criado. Escreva o que muda.');
}

// ---------- cerimonia de chegada, itens e inventario (estilo Zelda) ----------
function glifoSVG(chave) {
  const g = {
    carta: '<rect x="5.5" y="3.5" width="13" height="17" rx="1"/><path d="M8 7.5h8M8 10.5h8M8 13.5h5" stroke="#241804" stroke-width="1.2" fill="none" stroke-linecap="round"/><circle cx="15.2" cy="16.9" r="2.4" fill="#8a1f1f" stroke="#241804" stroke-width="0.5"/>',
    rede: '<path d="M4 5h16l-8 15z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7.3 5l2.6 12M13 5l-2.9 13M5.7 9.5h12.6M7.5 14h9M9.3 18h5.4" stroke="currentColor" stroke-width="0.85" fill="none"/>',
    ampulheta: '<path d="M6 3.2h12M6 20.8h12" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/><path d="M7.5 3.5c0 4.4 4.5 5.4 4.5 8.5s-4.5 4.1-4.5 8.5M16.5 3.5c0 4.4-4.5 5.4-4.5 8.5s4.5 4.1 4.5 8.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 6.5h6l-3 4.2z"/><path d="M12 13.8l3 5.2H9z"/>',
    estrela: '<path d="M12 3l7.8 13.5H4.2z" fill-opacity="0.92"/><path d="M12 21L4.2 7.5h15.6z" fill-opacity="0.92"/>',
    lamina: '<path d="M12 2l2.2 13h-4.4z"/><rect x="8.4" y="14.4" width="7.2" height="1.8" rx="0.5"/><rect x="11" y="16" width="2" height="6" rx="0.6"/>',
    regua: '<rect x="3" y="8.5" width="18" height="7" rx="1"/><path d="M6 8.5v3.4M9 8.5v2.2M12 8.5v3.4M15 8.5v2.2M18 8.5v3.4" stroke="#241804" stroke-width="1.1"/>',
    chave: '<circle cx="8" cy="8" r="4.2"/><circle cx="8" cy="8" r="1.5" fill="#241804"/><path d="M10.9 10.9L19 19M16.2 16.2l2.2-2.2M18.4 18.4l1.5-1.5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/>',
    // ---- glifos "hoje": o gemeo de cada peca, no verso do cartao (espelho) ----
    audio: '<path d="M13 5.5l6.5 5.5-6.5 5.5v-3.2c-4.2-.2-7.2 1-9.2 3.9.2-5.4 3.4-8.2 9.2-8.4V5.5z"/>',
    sidur: '<path d="M12 7c-2.3-1.4-5.2-1.8-8-1.2v11c2.8-.6 5.7-.2 8 1.2 2.3-1.4 5.2-1.8 8-1.2v-11c-2.8-.6-5.7-.2-8 1.2z"/><path d="M12 7v11M5.5 8.5h4M5.5 11h4M14.5 8.5h4M14.5 11h4" stroke="#241804" stroke-width="0.85" fill="none" stroke-linecap="round"/>',
    cartaz_rei: '<path d="M4 8.5l2.8 2.6L12 6l5.2 5.1L20 8.5l-1.4 8.5H5.4z"/><rect x="5" y="17.6" width="14" height="2.2" rx="0.4"/><circle cx="7" cy="10.6" r="0.9" fill="#241804"/><circle cx="12" cy="9" r="0.9" fill="#241804"/><circle cx="17" cy="10.6" r="0.9" fill="#241804"/>',
    pedra: '<path d="M7 15.5L4.5 10 9 6.5l6 .5 4 4.5-2.5 6.5-7 .8z"/><path d="M9 6.5l2 5.2 6-1.2M11 11.7l-1.4 6.6M11 11.7l6.2-.4" stroke="#241804" stroke-width="0.8" fill="none"/>',
    espelho: '<ellipse cx="12" cy="9" rx="6.2" ry="7"/><ellipse cx="12" cy="9" rx="4.3" ry="5" fill="#241804" opacity="0.22"/><path d="M9.4 6a4 5 0 0 0-1 4.4" stroke="#fffaeb" stroke-width="1.2" fill="none" stroke-linecap="round" opacity="0.6"/><rect x="10.8" y="15.6" width="2.4" height="5.4" rx="1"/>',
    cartaz_traidor: '<rect x="4.5" y="4" width="15" height="10.5" rx="1"/><rect x="11" y="14.5" width="2" height="6.5" rx="0.4"/><path d="M8 7l8 6M16 7l-8 6" stroke="#241804" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
    colete: '<path d="M8 3l4 3.2L16 3l3.5 2.8-2 3.7v11.5h-4.5V13h-2v7H6.5V9.5l-2-3.7z"/><rect x="7.6" y="12" width="2.2" height="2.2" fill="#241804"/><rect x="14.2" y="12" width="2.2" height="2.2" fill="#241804"/>',
    fosforo: '<rect x="11" y="9" width="2" height="12" rx="0.8"/><path d="M12 2.5c-2 2-2.6 3.8-1.6 5.4.7 1.1 2.5 1.1 3.2 0 1-1.6.4-3.4-1.6-5.4z" fill="#a83218"/><path d="M12 5.2c-.8 1-1 1.8-.5 2.6.4.5 1.1.5 1.5 0 .5-.8.3-1.6-1-2.6z" fill="#f0b038"/>',
    galao: '<path d="M6 8.5h8.5l3 3v8.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1z"/><rect x="7" y="5.5" width="4.5" height="3" rx="0.5"/><path d="M6 8.3c0-2 1.1-3 3-3" stroke="#241804" stroke-width="1.2" fill="none"/><rect x="7" y="13" width="6.5" height="1.6" fill="#241804" opacity="0.5"/>',
    templo: '<path d="M12 3l9 4.5H3z"/><rect x="4.5" y="8" width="2" height="8.5"/><rect x="8.5" y="8" width="2" height="8.5"/><rect x="13.5" y="8" width="2" height="8.5"/><rect x="17.5" y="8" width="2" height="8.5"/><rect x="3" y="17" width="18" height="2.5"/>',
    megafone: '<path d="M4 10v4a1 1 0 0 0 .8 1l2.2.4 7 4V4.6l-7 4-2.2.4A1 1 0 0 0 4 10z"/><path d="M17.5 8.5c1.8 1.6 1.8 5.4 0 7M19.6 6.6c2.9 2.6 2.9 8.2 0 10.8" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
  };
  return '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" fill="currentColor">' + (g[chave] || g.carta) + '</svg>';
}

function limparAlvo() { if (marcadorAlvo && mapa) mapa.removeLayer(marcadorAlvo); marcadorAlvo = null; }

// A etapa foi "chegada": pisca a tela, acende o diamante no ponto, entrega o item.
// Dispara pelo GPS (ao chegar perto do ponto) ou pela senha (fallback sem sinal).
function cerimoniaChegada() {
  const et = etapaObj();
  if (cerimoniaFeita || !et) return;
  cerimoniaFeita = true;
  tocarSom(et.som_chegada);   // o toque da chegada (mp3 por etapa); sem som_chegada, nao faz nada
  flashDourado();
  // o item vem primeiro: uma falha ao acender o alvo no mapa nunca pode custar o item do inventario
  ganharItem(et);
  try { acenderAlvoAtual(et); } catch (e) { console.warn('acenderAlvoAtual falhou', e); }
}

function flashDourado() {
  const f = $('flash-cerimonia');
  if (!f) return;
  f.classList.remove('oculto');
  requestAnimationFrame(() => f.classList.add('pisca'));
  setTimeout(() => { f.classList.remove('pisca'); f.classList.add('oculto'); }, 720);
}

function acenderAlvoAtual(et, semVoo) {
  limparAlvo();
  if (!mapa || !et.corredor || !et.corredor.length) return;
  const pt = et.corredor[et.corredor.length - 1];
  const ic = L.divIcon({ className: '', html: '<div class="diamante"><span class="diamante-luz"></span><span class="diamante-corpo"></span></div>', iconSize: [46, 46], iconAnchor: [23, 23] });
  marcadorAlvo = L.marker(pt, { icon: ic, zIndexOffset: 700 }).addTo(mapa)
    .bindTooltip(et.titulo || '', { direction: 'top', offset: [0, -20] });
  // no boot/reload a frio a cerimonia roda antes do invalidateSize que mostrarTela agenda:
  // sem dar tamanho ao mapa aqui, o flyTo calcula sobre um container 0x0 e estoura "Invalid LatLng (NaN, NaN)"
  mapa.invalidateSize();
  if (!semVoo) voarPara(pt, Math.max(mapa.getZoom(), CONFIG.zoom.inicial), 1.0); // no restore (reload) o diamante volta sem saltar a camera
}

function ganharItem(et) {
  if (!et.item) return;
  if (inventario.some(x => x.etapa === et.id)) { atualizarContadorInv(); return; }
  const it = { etapa: et.id, nome: et.item.nome, glifo: et.item.glifo, sobre: et.item.sobre };
  inventario.push(it);
  salvarInventario();
  atualizarContadorInv();
  mostrarItemGanho(it);
  talvezRevelarSacola();   // se esse foi o ultimo item, a virada da sacola cheia (rota fariseus)
}

// a cerimonia do item: o overlay entra com o bau abrindo (CSS, disparado por .visivel),
// o glifo emerge do bau para o card e, no fim, a sacola pisca (a peca foi guardada).
// prefers-reduced-motion (.sem-bau): pula o bau, mostra o item direto.
// Nunca trava: se um timer falhar, o glifo ja emerge sozinho pelo CSS e o card fica legivel.
function mostrarItemGanho(it) {
  const el = $('item-ganho');
  limparCerimoniaItem();   // cancela uma cerimonia anterior ainda em curso (itens em sequencia)
  $('item-ganho-glifo').innerHTML = glifoSVG(it.glifo);
  $('item-ganho-nome').textContent = it.nome;
  $('item-ganho-sobre').textContent = it.sobre;
  const reduz = reduzMovimento();
  el.classList.toggle('sem-bau', reduz);
  el.classList.remove('oculto');
  requestAnimationFrame(() => el.classList.add('visivel'));
  agendarCerimonia(destacarSacola, reduz ? 250 : 980);   // a peca guardada: a sacola se destaca
  // o item FICA na tela ate um toque (precisa dar tempo de LER: o "sobre" guarda o segredo do
  // codigo); teto de 45s pra nao prender a tela se ninguem tocar
  const fechar = () => {
    el.onclick = null;
    el.classList.remove('visivel');
    agendarCerimonia(() => el.classList.add('oculto'), 400);
  };
  el.onclick = fechar;
  agendarCerimonia(fechar, 45000);
}
// timers da cerimonia reunidos: a tela final (mostrarFinal) limpa tudo de uma vez, sem sobrar som/pisca
function agendarCerimonia(fn, ms) {
  const t = setTimeout(fn, ms);
  (mostrarItemGanho._timers || (mostrarItemGanho._timers = [])).push(t);
  return t;
}
function limparCerimoniaItem() {
  (mostrarItemGanho._timers || []).forEach(clearTimeout);
  mostrarItemGanho._timers = [];
  const ig = $('item-ganho');
  if (ig) ig.onclick = null;
  const b = $('botao-inventario');
  if (b) b.classList.remove('sacola-destaca');
}
// a sacola pisca/pulsa: mostra onde a peca recem-ganha ficou guardada (o contador ja foi atualizado antes)
function destacarSacola() {
  const b = $('botao-inventario');
  if (!b) return;
  b.classList.remove('sacola-destaca');
  void b.offsetWidth;   // reinicia a animacao mesmo em itens seguidos
  b.classList.add('sacola-destaca');
  agendarCerimonia(() => b.classList.remove('sacola-destaca'), 1500);
}

function atualizarContadorInv() {
  const c = $('inv-contador');
  if (!c) return;
  const n = inventario.length;
  c.textContent = n || '';
  c.classList.toggle('oculto', !n);
}

function abrirInventario() {
  if (!rotaAtiva) return;
  const grade = $('inv-grade');
  grade.innerHTML = '';
  rotaAtiva.etapas.forEach(et => {
    if (!et.item) return;
    const tem = inventario.find(x => x.etapa === et.id);
    const cel = document.createElement('div');
    cel.className = 'inv-item' + (tem ? '' : ' vazio');
    if (tem) {
      cel.innerHTML = '<div class="inv-glifo">' + glifoSVG(et.item.glifo) + '</div>'
        + '<p class="inv-nome"></p><p class="inv-sobre"></p>';
      cel.querySelector('.inv-nome').textContent = et.item.nome;
      cel.querySelector('.inv-sobre').textContent = et.item.sobre;
      if (et.item.espelho) {   // a peca tem um gemeo de hoje: vira clicavel e ganha a dica
        cel.classList.add('tem-espelho');
        cel.setAttribute('role', 'button');
        cel.tabIndex = 0;
        const dica = document.createElement('p');
        dica.className = 'inv-vira';
        dica.textContent = 'ver hoje ↻';
        cel.appendChild(dica);
        cel.addEventListener('click', () => abrirEspelho(et));
        cel.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirEspelho(et); } });
      }
    } else {
      cel.innerHTML = '<div class="inv-glifo inv-glifo-vazio">?</div><p class="inv-nome">Ainda não achado</p>';
    }
    grade.appendChild(cel);
  });
  // a virada fica sempre relegivel aqui embaixo, num painel destacado, quando a sacola esta completa
  const painel = $('inv-revelacao');
  if (painel) {
    const rev = rotaAtiva.revelacao_sacola;
    if (rev && inventarioCompleto(rotaAtiva)) {
      preencherRevelacao(rev, $('inv-rev-glifos'), $('inv-rev-titulo'), $('inv-rev-texto'), $('inv-rev-dica'));
      painel.classList.remove('oculto');
    } else {
      painel.classList.add('oculto');
    }
  }
  $('tela-inventario').classList.remove('oculto');
}

// ---------- o cartao-espelho: a peca de 68 (frente) e o gemeo de hoje (verso) ----------
// abre sempre pela frente (68); um toque no cartao vira para o hoje.
function abrirEspelho(et) {
  if (!et || !et.item || !et.item.espelho) return;
  const it = et.item, esp = it.espelho;
  $('esp-frente-glifo').innerHTML = glifoSVG(it.glifo);
  $('esp-frente-nome').textContent = it.nome;
  $('esp-frente-sobre').textContent = it.sobre || '';
  $('esp-verso-glifo').innerHTML = glifoSVG(esp.glifo);
  $('esp-verso-nome').textContent = esp.nome || '';
  $('esp-verso-texto').textContent = esp.texto || '';
  $('espelho-carta').classList.remove('virada');
  $('tela-espelho').classList.remove('oculto');
}
function fecharEspelho() { $('tela-espelho').classList.add('oculto'); }

// ---------- a revelacao da sacola cheia (a virada da rota fariseus) ----------
// "Completo" = para cada etapa que define et.item, a sacola ja tem o item correspondente.
// So a rota com revelacao_sacola dispara; as outras nao tem o campo e sao ignoradas.
function inventarioCompleto(rota) {
  if (!rota) return false;
  const slots = (rota.etapas || []).filter(et => et.item);
  if (!slots.length) return false;
  return slots.every(et => inventario.some(x => x.etapa === et.id));
}
function revelacaoJaVista(rota) {
  try { return localStorage.getItem(CHAVE_SACOLA + rota.id) === '1'; } catch (e) { return false; }
}
function marcarRevelacaoVista(rota) {
  try { localStorage.setItem(CHAVE_SACOLA + rota.id, '1'); } catch (e) {}
}

// chamada a cada item novo: dispara a virada UMA vez, quando a sacola acaba de completar
function talvezRevelarSacola() {
  const rota = rotaAtiva;
  if (!rota || !rota.revelacao_sacola) return;   // so a rota que carrega a virada
  if (!inventarioCompleto(rota)) return;         // ainda faltam pecas
  if (revelacaoJaVista(rota)) return;            // ja rolou nesta rota: nao repete no automatico
  marcarRevelacaoVista(rota);
  // deixa a cerimonia do ultimo item (mostrarItemGanho, ~3,4s) respirar antes da virada solene
  clearTimeout(talvezRevelarSacola._t);
  talvezRevelarSacola._t = setTimeout(() => mostrarRevelacaoSacola(rota.revelacao_sacola), 3400);
}

// preenche os glifos coletados + titulo + texto (lidos do rotas.json) nos elementos dados
function preencherRevelacao(rev, glifosEl, tituloEl, textoEl, dicaEl) {
  let temEspelho = false;
  if (glifosEl) {
    glifosEl.innerHTML = '';
    glifosEl.removeAttribute('aria-hidden');   // os glifos agora podem ser tocados
    (rotaAtiva && rotaAtiva.etapas || []).forEach(et => {
      if (!et.item || !inventario.some(x => x.etapa === et.id)) return;
      const g = document.createElement('span');
      g.className = 'rev-glifo';
      g.innerHTML = glifoSVG(et.item.glifo);
      if (et.item.espelho) {   // a peca tem gemeo de hoje: tocar abre o cartao-espelho
        temEspelho = true;
        g.classList.add('rev-glifo-toca');
        g.setAttribute('role', 'button');
        g.tabIndex = 0;
        g.setAttribute('aria-label', et.item.nome + ': ver o gêmeo de hoje');
        g.addEventListener('click', () => abrirEspelho(et));
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirEspelho(et); } });
      }
      glifosEl.appendChild(g);
    });
  }
  if (tituloEl) tituloEl.textContent = rev.titulo || '';
  if (textoEl) textoEl.textContent = rev.texto || '';
  if (dicaEl) dicaEl.textContent = temEspelho ? 'Toquem cada peça acima: ela vira e mostra o gêmeo de hoje.' : '';
}

function mostrarRevelacaoSacola(rev) {
  if (!rev) return;
  preencherRevelacao(rev, $('rev-glifos'), $('rev-titulo'), $('rev-texto'), $('rev-dica'));
  tocarSom('sino');   // um toque solene marca a virada (best-effort; sem audio, nao faz nada)
  const el = $('revelacao-sacola');
  if (!el) return;
  el.classList.remove('oculto');
  requestAnimationFrame(() => el.classList.add('visivel'));
}
function fecharRevelacaoSacola() {
  const el = $('revelacao-sacola');
  if (!el) return;
  el.classList.remove('visivel');
  setTimeout(() => el.classList.add('oculto'), 420);
}

// ---------- fotos da etapa: galeria + lightbox (modo Easy de referencia) ----------
function preencherFotos(cont, fotos) {
  if (!cont) return;
  cont.innerHTML = '';
  (fotos || []).forEach(src => {
    const im = document.createElement('img');
    im.src = src; im.alt = ''; im.loading = 'lazy';
    im.onerror = () => im.remove();
    im.addEventListener('click', () => abrirFoto(src));
    cont.appendChild(im);
  });
}

function abrirFoto(src) {
  const g = $('foto-grande');
  if (g) g.src = src;
  $('tela-foto').classList.remove('oculto');
}
function fecharFoto() { $('tela-foto').classList.add('oculto'); }

// galeria de um toque (botao flutuante): as fotos de referencia da etapa atual, grandes,
// sempre a mao; toque numa foto amplia no lightbox (que abre por cima da galeria)
function abrirGaleria() {
  const et = etapaObj();
  const fotos = (et && et.fotos) || [];
  if (!fotos.length) { toast(TEXTOS.galeria_vazia || 'Esta etapa não tem imagens de referência.'); return; }
  const lista = $('galeria-lista');
  lista.innerHTML = '';
  fotos.forEach((src) => {
    const im = document.createElement('img');
    im.src = src;
    im.alt = '';
    im.loading = 'lazy';
    im.onerror = () => im.remove();
    im.addEventListener('click', () => abrirFoto(src));
    lista.appendChild(im);
  });
  $('tela-galeria').classList.remove('oculto');
}

// coach dos socorros: mostra uma vez (por aparelho) na 1a etapa vista.
// coachVisto guarda a decisao em memoria: em aba privada (sem localStorage) o coach
// reaparecia a cada etapa; com a flag de sessao, aparece no maximo uma vez.
let coachVisto = false;
function talvezMostrarCoach() {
  if (coachVisto) return;
  coachVisto = true;
  try { if (localStorage.getItem('peula68_coach') === '1') return; } catch (e) {}
  $('coach-socorros').classList.remove('oculto');
}

// ---------- cronometro por etapa ----------
function formatarTempo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function iniciarCronometro() {
  etapaInicioTs = Date.now();
  let escondido = false;
  try { escondido = localStorage.getItem('peula68_nocron') === '1'; } catch (e) {}
  const el = $('cronometro');
  if (el) { el.classList.toggle('oculto', escondido); el.title = 'toque para esconder'; }
  if (escondido) { pararCronometro(); return; } // segue medindo (temposEtapa), so nao mostra o chip
  pintarCronometro();
  clearInterval(cronTimer);
  cronTimer = setInterval(pintarCronometro, 1000);
}
function pintarCronometro() {
  const el = $('cronometro');
  if (el && etapaInicioTs) el.textContent = formatarTempo(Date.now() - etapaInicioTs);
}
function pararCronometro() { clearInterval(cronTimer); cronTimer = null; }

// ---------- voltar ao ultimo ponto marcado (quando o grupo se perde) ----------
function ultimoPontoMarcado() {
  if (!rotaAtiva) return null;
  const cumpridas = Math.min(etapaAtual - 1, rotaAtiva.etapas.length);
  for (let i = cumpridas - 1; i >= 0; i--) {
    const corr = rotaAtiva.etapas[i].corredor;
    if (corr && corr.length) return corr[corr.length - 1];
  }
  return rotaAtiva.ponto_inicial || null; // ainda na 1a etapa: volta ao portao de partida
}
function voltarAoUltimoPonto() {
  const pt = ultimoPontoMarcado();
  if (!pt || !mapa) { toast(TEXTOS.sem_ponto); return; }
  voarPara(pt, Math.max(mapa.getZoom(), CONFIG.zoom.inicial), 0.9);
}

// ---------- gate inicial: comecar longe, ir ate o portao e tocar ESTOU AQUI ----------
function mostrarGateInicial() {
  if (!rotaAtiva) { entrarEtapa(); return; }
  mostrarTela('jogo');
  atualizarHeader();
  $('cronometro').classList.add('oculto');     // a 1a etapa ainda nao comecou
  $('painel').classList.add('painel-fechado');  // so o mapa e o brilho do portao
  $('painel-mostrar').classList.add('oculto');  // durante o gate, o pino nao aparece
  ajustarMapaAoPainel();
  limparBrilhoGate();
  const pt = rotaAtiva.ponto_inicial;
  if (mapa && pt) {
    const ic = L.divIcon({ className: '', html: '<div class="brilho-portao"><span></span></div>', iconSize: [54, 54], iconAnchor: [27, 27] });
    marcadorBrilhoGate = L.marker(pt, { icon: ic, zIndexOffset: 650, interactive: false }).addTo(mapa);
    // o mapa acabou de ficar visivel (vinha da abertura): da o tamanho a ele antes de voar,
    // senao o flyTo calcula sobre um container 0x0 e estoura "Invalid LatLng (NaN, NaN)"
    setTimeout(() => { mapa.invalidateSize(); voarPara(pt, Math.max(mapa.getZoom(), CONFIG.zoom.inicial), 1.0); }, 80);
  }
  configurarGateRetrato();   // se a rota tem retrato de abertura, e ele que comeca a caca
  $('gate-inicial').classList.remove('oculto');
  aguardandoGate = true;
}

// no gate inicial: se a rota tem missao_abertura (foto), o RETRATO do time e o que comeca a caca.
// Enviar a foto substitui/complementa o "estou aqui" (que fica de reserva, junto do gate por GPS).
function configurarGateRetrato() {
  const ma = rotaAtiva && rotaAtiva.missao_abertura;
  const bloco = $('gate-retrato');
  const estouAqui = $('gate-botao');
  if (ma && (ma.tipo === 'foto' || ma.tipo === undefined) && bloco) {
    $('gate-retrato-texto').textContent = ma.texto || '';
    $('gate-retrato-btn-txt').textContent = TEXTOS.gate_retrato_botao || 'Enviar o retrato e começar';
    bloco.classList.remove('oculto');
    // com retrato de abertura, a foto e OBRIGATORIA (pedido do Allan em campo): sem botao de pular
    if (estouAqui) estouAqui.classList.add('oculto');
  } else if (bloco) {
    bloco.classList.add('oculto');
    if (estouAqui) { estouAqui.classList.remove('oculto', 'gate-reserva'); estouAqui.textContent = TEXTOS.gate_botao || 'Estou aqui'; }
  }
}

// trava suave de GPS pras fotos: com posicao conhecida exige estar no lugar; sem GPS, deixa
function pertoDoPonto(pt, raio) {
  if (!posAtual || !pt) return true;
  const folga = Math.min(posAtual.acc || 0, 30);
  return distanciaAoCorredorM(posAtual, [pt]) <= raio + folga + 15;
}
function pertoDoGate() {
  return pertoDoPonto(rotaAtiva && rotaAtiva.ponto_inicial, 55);
}
function pertoDoCheckpoint(et) {
  const fim = (et && et.corredor && et.corredor.length) ? et.corredor[et.corredor.length - 1] : null;
  return pertoDoPonto(fim, (et && (et.raio_chegada_m || et.raio_m)) || 50);
}

let avisoChegadaGateDado = false;
function verificarChegadaGate() {
  if (!aguardandoGate || !posAtual || !rotaAtiva) return;
  const pt = rotaAtiva.ponto_inicial;
  const folga = Math.min(posAtual.acc || 0, 30);
  if (!pt || distanciaAoCorredorM(posAtual, [pt]) > 55 + folga) return;
  const ma = rotaAtiva.missao_abertura;
  if (ma && (ma.tipo === 'foto' || ma.tipo === undefined)) {
    // com retrato de abertura, a chegada por GPS nao engole a missao: avisa 1x e espera a
    // foto (ou o botao reserva "toquem aqui") comecar a caca
    if (!avisoChegadaGateDado) { avisoChegadaGateDado = true; toast(TEXTOS.gate_chegou_retrato || 'Vocês chegaram. Tirem o retrato do grupo pra abrir a caça.', 6000); }
    return;
  }
  abrirPrimeiraEtapa();
}

// tira o jogador do gate inicial: esconde o card "ESTOU AQUI", apaga o brilho do portão
// e traz o painel de volta. Extraído para que a entrada na etapa (inclusive por sync)
// possa limpar o gate com segurança, sem o card ficar preso por cima do jogo.
function sairDoGate() {
  if (!aguardandoGate) return;
  aguardandoGate = false;
  $('gate-inicial').classList.add('oculto');
  limparBrilhoGate();
  $('painel').classList.remove('painel-fechado');
  atualizarPinoMostrar();
}

function abrirPrimeiraEtapa() {
  if (!aguardandoGate) return;
  primarAudio();   // "estou aqui" tambem serve de 1o gesto pra destravar o som
  sairDoGate();
  entrarEtapa();
  toast(TEXTOS.gate_chegou || TEXTOS.portao_abriu);
}

function limparBrilhoGate() {
  if (marcadorBrilhoGate && mapa) mapa.removeLayer(marcadorBrilhoGate);
  marcadorBrilhoGate = null;
}

// ---------- bussola: a agulha aponta pro fim do corredor da etapa ----------
function bearingTo(from, to) {
  const lat1 = from.lat * Math.PI / 180, lat2 = to[0] * Math.PI / 180;
  const dLng = (to[1] - from.lng) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function destinoEtapa() {
  const et = etapaObj();
  if (!et || !et.corredor || !et.corredor.length) return null;
  return et.corredor[et.corredor.length - 1];
}

function toggleBussola() {
  if (bussolaAtiva) { desligarBussola(); return; }
  ligarBussola();
}

function ligarBussola() {
  bussolaAtiva = true;
  $('botao-bussola').classList.add('ativa');
  $('bussola-hud').classList.remove('oculto');
  const liga = () => {
    bussolaListener = onOrientacao;
    window.addEventListener('deviceorientationabsolute', bussolaListener, true);
    window.addEventListener('deviceorientation', bussolaListener, true);
  };
  // iOS 13+: precisa de permissao, e so a partir de um gesto (este toque conta)
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    DOE.requestPermission().then((r) => {
      if (r === 'granted') { liga(); toast(TEXTOS.bussola_rotulo); }
      else toast(TEXTOS.bussola_sem_heading);
    }).catch(() => toast(TEXTOS.bussola_sem_heading));
  } else {
    liga();
    toast(TEXTOS.bussola_rotulo);
  }
  atualizarBussola();
}

function desligarBussola() {
  bussolaAtiva = false;
  $('botao-bussola').classList.remove('ativa');
  $('bussola-hud').classList.add('oculto');
  if (bussolaListener) {
    window.removeEventListener('deviceorientationabsolute', bussolaListener, true);
    window.removeEventListener('deviceorientation', bussolaListener, true);
    bussolaListener = null;
  }
  bussolaHeading = null;
}

function onOrientacao(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;   // iOS: ja e do norte
  else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360; // alpha cresce anti-horario
  if (h === null) return;
  bussolaHeading = h;
  atualizarBussola();
}

function atualizarBussola() {
  if (!bussolaAtiva) return;
  const agulha = $('bussola-agulha');
  const distEl = $('bussola-dist');
  const destino = destinoEtapa();
  if (!posAtual || !destino) { if (distEl) distEl.textContent = '· · ·'; return; }
  const brg = bearingTo(posAtual, destino);
  // sem heading do aparelho: a agulha aponta relativa ao norte do mapa (mapa e norte-para-cima)
  const rot = bussolaHeading === null ? brg : (brg - bussolaHeading);
  if (agulha) agulha.style.transform = 'translate(-50%, -50%) rotate(' + rot.toFixed(0) + 'deg)';
  const d = distanciaAoCorredorM(posAtual, [destino]);
  if (distEl) distEl.textContent = isFinite(d) ? (d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km') : '';
}

// ---------- simbolos dos beats (glifos SVG proprios) ----------
// Chaves usadas nos beats do rotas.json: templarios (cruz de Jerusalem), cruz, seta, shuk, maria.
function simboloSVG(chave) {
  const g = {
    // cruz de Jerusalem: a cruz potente (bracos em T) no centro + 4 marcas nos quadrantes
    templarios:
      '<path d="M10.7 4h2.6v16h-2.6z"/><path d="M4 10.7h16v2.6H4z"/>' +
      '<path d="M8.3 4h7.4v1.7H8.3zM8.3 18.3h7.4V20H8.3zM4 8.3h1.7v7.4H4zM18.3 8.3H20v7.4h-1.7z"/>' +
      '<circle cx="7" cy="7" r="1.05"/><circle cx="17" cy="7" r="1.05"/><circle cx="7" cy="17" r="1.05"/><circle cx="17" cy="17" r="1.05"/>',
    // cruz latina simples
    cruz: '<path d="M10.7 3h2.6v6.1H19v2.6h-5.7V21h-2.6v-9.3H5V9.1h5.7z"/>',
    // seta de rumo (pra frente)
    seta: '<path d="M4 10.4h9.2V6l6.4 6-6.4 6v-4.4H4z"/>',
    // shuk: uma arcada de tres arcos (as ruas abobadadas do mercado) sobre a linha do chao
    shuk:
      '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
      '<path d="M3 20v-6a3 3 0 0 1 6 0M9 14a3 3 0 0 1 6 0M15 14a3 3 0 0 1 6 0v6"/>' +
      '<path d="M3 20h18"/></g>',
    // maria: cabeca com veu (auréola em arco) e os ombros do manto
    maria:
      '<circle cx="12" cy="8.4" r="3.1"/>' +
      '<path d="M6.4 20.5c0-3.6 2.5-6.1 5.6-6.1s5.6 2.5 5.6 6.1z"/>' +
      '<path d="M7.7 5.2a5.6 5.6 0 0 1 8.6 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  };
  return '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" fill="currentColor">' + (g[chave] || g.seta) + '</svg>';
}

// ---------- beats: pops de historia no caminho (marcador com o simbolo + som), uma vez cada ----------
function chaveBeatsEtapa(et) { return (rotaAtiva ? rotaAtiva.id : '?') + ':' + (et ? et.id : '?'); }
function beatsFeitosDaEtapa(et) {
  const k = chaveBeatsEtapa(et);
  return beatsPersist[k] || (beatsPersist[k] = []);
}

function verificarBeats(et) {
  if (!et || !et.beats || !et.beats.length || !posAtual) return;
  const feitos = beatsFeitosDaEtapa(et);
  const folga = Math.min(posAtual.acc || 0, 20);
  et.beats.forEach((b, i) => {
    if (!b || !b.ponto || feitos.indexOf(i) >= 0) return;
    if (distanciaAoCorredorM(posAtual, [b.ponto]) <= (b.raio_m || 20) + folga) {
      feitos.push(i);
      salvarBeatsPersist();
      dispararBeat(b);
    }
  });
}

function dispararBeat(b) {
  mostrarSussurro(b.texto, b.simbolo, 14000);   // o pop de mensagem no mapa (14s: da pra ler andando; o marcador guarda o texto no toque)
  desenharMarcadorBeat(b);                      // o marcador com o glifo fica no mapa
  if (b.som) tocarSom(b.som);
}

function desenharMarcadorBeat(b) {
  if (!mapa || !b || !b.ponto) return;
  const ic = L.divIcon({ className: '', html: '<div class="beat-marco">' + simboloSVG(b.simbolo) + '</div>', iconSize: [34, 34], iconAnchor: [17, 17] });
  const m = L.marker(b.ponto, { icon: ic, zIndexOffset: 560 }).addTo(mapa);
  if (b.texto) m.bindTooltip(b.texto, { direction: 'top', offset: [0, -16] });
  marcadoresBeat.push(m);
}

function limparMarcadoresBeat() {
  marcadoresBeat.forEach(m => mapa && mapa.removeLayer(m));
  marcadoresBeat = [];
}

// reload no meio da etapa: os beats ja disparados voltam ao mapa (so o marcador, sem pop nem som)
function redesenharBeatsDisparados(et) {
  if (!et || !et.beats) return;
  beatsFeitosDaEtapa(et).forEach(i => { if (et.beats[i]) desenharMarcadorBeat(et.beats[i]); });
}

// ---------- sussurro do mapa: o pop dos beats e do "revela" (com glifo opcional) ----------
function mostrarSussurro(texto, simbolo, ms) {
  const el = $('sussurro');
  if (!el) { if (texto) toast(texto, ms || 6000); return; }
  const gl = $('sussurro-glifo');
  if (simbolo) { gl.innerHTML = simboloSVG(simbolo); gl.classList.remove('oculto'); }
  else { gl.innerHTML = ''; gl.classList.add('oculto'); }
  $('sussurro-texto').innerHTML = textoComAsterisco(texto || '');
  el.classList.remove('oculto');
  requestAnimationFrame(() => el.classList.add('visivel'));
  clearTimeout(mostrarSussurro._t);
  mostrarSussurro._t = setTimeout(fecharSussurro, ms || 10000);
}
function fecharSussurro() {
  const el = $('sussurro');
  if (!el) return;
  el.classList.remove('visivel');
  setTimeout(() => el.classList.add('oculto'), 400);
}

// ---------- foto da missao: sobe pro Supabase (best-effort, nunca trava) ----------
// O retrato de abertura (etapa 0) e as fotos das etapas "foto" sobem comprimidas pro schema peula
// (RPC peula_jogo_foto, DDL em db/0003_jogo_fotos.sql). Se a rede falhar, a foto entra numa fila
// de reenvio desta sessao e o jogo SEGUE assim mesmo (a palavra do madrich fica de reserva).
function salaFotoAtual() {
  if (sala) return sala;   // ja definida pela sincronia (rota + grupo)
  if (!rotaAtiva) return '';
  return normalizar(rotaAtiva.id + (grupoAtivo || 'SOLO'));
}

// sobe uma foto (com timeout, pra rede lenta nao travar o jogo). Resolve true/false, nunca rejeita.
async function subirFotoJogo(blob, etapaId) {
  try {
    const b64 = await admBlobParaB64(blob);   // reusa o utilitario do ADM (base64 sem o prefixo)
    const corpo = {
      p_id: admUuid(), p_sala: salaFotoAtual(), p_rota: rotaAtiva ? rotaAtiva.id : '',
      p_etapa: (etapaId != null ? etapaId : 0), p_dispositivo: admDispId(),
      p_mime: (blob.type || 'image/jpeg'), p_dados_b64: b64,
    };
    const ctrl = new AbortController();
    const tmo = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(SB_URL + '/rest/v1/rpc/peula_jogo_foto', {
        method: 'POST',
        headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + SB_ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo), signal: ctrl.signal,
      });
      // 204 (void) tambem conta como ok. 4xx (foto grande demais, config) e recusa
      // definitiva: reenviar a mesma foto nunca vai passar, entao nao volta pra fila
      return { ok: r.ok, retry: !r.ok && r.status >= 500 };
    } finally { clearTimeout(tmo); }
  } catch (e) { return { ok: false, retry: true }; }   // rede caiu / timeout: vale tentar depois
}

// comprime, tenta subir e chama `aoTerminar` (o avanco) SEMPRE: enviar e o gatilho, mas rede ruim
// nao pode prender o grupo. O que nao subiu vai pra fila e tenta de novo quando a rede voltar.
async function enviarFotoBest(file, etapaId, aoTerminar, textoOk, textoFalha) {
  toast(TEXTOS.missao_foto_enviando || 'Guardando a foto...', 3000);
  let blob = file;
  try { blob = await admComprimirFoto(file, 1600, 0.72); } catch (e) { /* compressao falhou: usa o arquivo cru */ }
  const res = await subirFotoJogo(blob, etapaId);
  if (res.ok) toast(textoOk || TEXTOS.missao_foto_ok || 'Foto no cofre. O caminho segue.');
  else if (res.retry) { fotosPendentes.push({ blob, etapaId }); toast(textoFalha || TEXTOS.missao_foto_falha || 'Sem sinal pra guardar agora. Sigam, mandem ao madrich por fora.', 6000); }
  else toast(TEXTOS.missao_foto_recusada || 'A foto não coube no cofre. Sigam, e mandem ao madrich por fora.', 6000);
  if (typeof aoTerminar === 'function') aoTerminar();
}

// retrato de abertura (etapa 0): enviar COMECA a caca (prima o audio, toca o som e abre a E1)
function enviarRetratoAbertura(file) {
  const som = (rotaAtiva && rotaAtiva.missao_abertura && rotaAtiva.missao_abertura.som) || 'inicio';
  primarAudio();
  tocarSom(som);
  enviarFotoBest(file, 0, () => { if (aguardandoGate) abrirPrimeiraEtapa(); },
    TEXTOS.retrato_ok || 'Retrato guardado. A caça começa.',
    TEXTOS.retrato_falha || 'Sem sinal pra guardar o retrato. A caça começa mesmo assim.');
}

// foto de missao de etapa (avanco "foto"): enviar AVANCA a etapa (cerimonia + item + proxima carta)
function enviarFotoMissao(file) {
  const et = etapaObj();
  if (!et) return;
  primarAudio();
  // o avanco fica amarrado a etapa de ORIGEM: um 2o toque (ou a senha ditada com upload em voo)
  // que termine depois do avanco nao pode avancar DE NOVO e pular uma etapa sem missao
  const idOrigem = et.id;
  const btn = $('missao-foto-btn');
  if (btn) { btn.disabled = true; btn.textContent = TEXTOS.missao_enviando_btn || 'Enviando...'; }
  enviarFotoBest(file, et.id, () => {
    const agora = etapaObj();
    if (agora && agora.id === idOrigem) { avancarEtapa(); return; } // o botao da etapa nova renasce habilitado
    const b2 = $('missao-foto-btn');
    if (b2) { b2.disabled = false; b2.textContent = TEXTOS.missao_enviar_foto || 'Enviar a foto e seguir'; }
  });
}

// ---------- video da missao: sobe pro Storage privado (best-effort, nunca trava) ----------
// Video nao cabe na tabela das fotos (teto de ~4MB): vai pro Supabase Storage, bucket privado
// 'jogo-midia' (DDL em db/0004_jogo_videos.sql). O app (anon) so INSERE o objeto, nao le nem
// lista. Se a rede cair, o video entra na MESMA fila das fotos (com kind:'video') e sobe quando
// a rede voltar. O jogo nunca espera o upload: o codigo (E4) ou a chegada por GPS (E5) e o gate.
function extDeMimeVideo(m) {
  m = (m || '').toLowerCase();
  if (m.indexOf('quicktime') >= 0) return 'mov';   // iPhone grava .mov (video/quicktime)
  if (m.indexOf('webm') >= 0) return 'webm';
  if (m.indexOf('matroska') >= 0) return 'mkv';
  if (m.indexOf('3gp') >= 0) return '3gp';
  return 'mp4';                                     // Android e a maioria: video/mp4
}

// sobe um video pro Storage. Resolve {ok, retry, caminho}, nunca rejeita. `caminhoPre` reusa o
// mesmo objeto num reenvio (idempotente: 409 "ja existe" conta como ok). retry=true so quando
// vale tentar de novo (rede caiu / 5xx); um 4xx (tamanho, config) nao volta pra fila.
async function subirVideoStorage(blob, etapaId, caminhoPre) {
  let caminho = caminhoPre || '';
  try {
    if (!caminho) {
      const ext = extDeMimeVideo(blob.type);
      caminho = [salaFotoAtual(), (rotaAtiva ? rotaAtiva.id : 'rota'), (etapaId != null ? etapaId : 0), admUuid() + '.' + ext].join('/');
    }
    const ctrl = new AbortController();
    const tmo = setTimeout(() => ctrl.abort(), 120000);   // video e pesado: ate 2 min antes de desistir
    try {
      const r = await fetch(SB_URL + '/storage/v1/object/' + BUCKET_MIDIA + '/' + caminho, {
        method: 'POST',
        headers: {
          'apikey': SB_ANON, 'Authorization': 'Bearer ' + SB_ANON,
          'Content-Type': blob.type || 'video/mp4', 'x-upsert': 'false',
        },
        body: blob, signal: ctrl.signal,
      });
      if (r.ok || r.status === 409) return { ok: true, retry: false, caminho };   // 409 = ja tinha subido
      return { ok: false, retry: r.status >= 500, caminho };   // 4xx: recusa definitiva; 5xx: tenta depois
    } finally { clearTimeout(tmo); }
  } catch (e) {
    return { ok: false, retry: true, caminho };   // rede caiu / timeout: vale reenfileirar
  }
}

// tenta subir o video e chama `aoTerminar` (o avanco) SEMPRE. Rede ruim vai pra fila, mas nao
// prende o grupo. 4xx (video grande demais / config) avisa "manda por fora" e segue mesmo assim.
async function enviarVideoBest(file, etapaId, aoTerminar) {
  if (file && file.size > 45 * 1024 * 1024) {
    // acima do teto do Storage (50MB no plano free): nem tenta nem refila, senao o clipe
    // re-sobe inteiro a cada volta de rede, comendo dados sem nunca caber
    toast(TEXTOS.missao_video_grande || 'O vídeo ficou grande demais pra subir daqui. Gravem um mais curto, ou mandem esse ao madrich por fora. O jogo segue.', 7000);
    if (typeof aoTerminar === 'function') aoTerminar();
    return;
  }
  const btn = $('missao-video-btn');
  if (btn) { btn.disabled = true; btn.textContent = TEXTOS.missao_enviando_btn || 'Enviando...'; }
  toast(TEXTOS.missao_video_enviando || 'Enviando o vídeo...', 4000);
  const res = await subirVideoStorage(file, etapaId, null);
  if (res.ok) toast(TEXTOS.missao_video_ok || 'Vídeo no cofre. O caminho segue.');
  else if (res.retry) { fotosPendentes.push({ kind: 'video', blob: file, etapaId: etapaId, caminho: res.caminho }); toast(TEXTOS.missao_video_fila || 'Sem sinal pra guardar agora. Deixem o app aberto: ele tenta de novo quando a rede voltar. Sigam.', 6000); }
  else toast(TEXTOS.missao_video_falha || 'Não deu pra guardar o vídeo aqui. Sigam, e mandem ao madrich por fora.', 6000);
  const b2 = $('missao-video-btn');
  if (b2) { b2.disabled = false; b2.textContent = TEXTOS.missao_enviar_video || 'Enviar o vídeo'; }
  if (typeof aoTerminar === 'function') aoTerminar();
}

// video de missao de etapa: enviar dispara o avanco (aoConcluir), que o chamador define por etapa
function enviarVideoMissao(file, etapaId, aoConcluir) {
  primarAudio();
  enviarVideoBest(file, etapaId, aoConcluir);
}

// a rede voltou: tenta subir de novo as fotos e videos que ficaram na fila desta sessao
function tentarReenviarPendentes() {
  if (!fotosPendentes.length || !navigator.onLine) return;
  const fila = fotosPendentes.slice();
  fotosPendentes = [];
  fila.forEach(async (item) => {
    item.tent = (item.tent || 0) + 1;   // teto de tentativas: rede que nunca engole nao vira loop eterno
    if (item.kind === 'video') {
      const r = await subirVideoStorage(item.blob, item.etapaId, item.caminho);
      if (!r.ok && r.retry && item.tent < 3) fotosPendentes.push(item);
      else if (!r.ok) toast(TEXTOS.missao_video_falha || 'Não deu pra guardar o vídeo aqui. Sigam, e mandem ao madrich por fora.', 6000);
    } else {
      const r = await subirFotoJogo(item.blob, item.etapaId);
      if (!r.ok && r.retry && item.tent < 4) fotosPendentes.push(item);
    }
  });
}

// ---------- o traidor (sinat chinam) ----------
// Um jogador por sala e sorteado no servidor (peula_papel) quando a sala chega na E2 com 2+
// jogadores registrados E o ADM marcou pontos numa rota de scouting chamada TRAIDOR-<corrente>.
// So o celular sorteado ve: a carta secreta, os pontos no mapa e o progresso. Os fieis nao veem
// NADA; a existencia do traidor so aparece na tela final (peula_revelacao). Tudo best-effort:
// sem rede ou sem pontos marcados, o jogo segue identico ao normal.
function lerPapelSalvo() {
  try {
    const p = JSON.parse(localStorage.getItem(CHAVE_PAPEL));
    if (p && p.sala === sala && p.papel) return p;
  } catch (e) {}
  return null;
}
function salvarPapel() {
  try {
    if (papelInfo) localStorage.setItem(CHAVE_PAPEL, JSON.stringify(Object.assign({ sala: sala }, papelInfo)));
  } catch (e) {}
}
function registrarJogador() {
  if (jogadorRegistrado || window.SOLO || !sala) return;
  if (!nomeJogador) { try { nomeJogador = localStorage.getItem(CHAVE_NOME) || ''; } catch (e) {} }
  if (!nomeJogador) return;   // sem nome (entrou por link/convite): fica fora do sorteio, jogo normal
  jogadorRegistrado = true;
  rpcSup('peula_jogador_entrar', { p_sala: sala, p_disp: admDispId(), p_nome: nomeJogador })
    .catch(() => { jogadorRegistrado = false; });   // sem rede: tenta de novo no proximo pulso
}
function consultarPapel() {
  if (window.SOLO || !sala || papelInfo) return;
  const salvo = lerPapelSalvo();
  if (salvo) {
    papelInfo = salvo;
    if (papelInfo.papel === 'traidor') desenharPontosTraidor();
    return;
  }
  rpcSup('peula_papel', { p_sala: sala, p_disp: admDispId() }).then((r) => {
    if (!r || papelInfo) return;
    if (r.papel === 'traidor') {
      papelInfo = { papel: 'traidor', pontos: r.pontos || [], batidos: (r.batidos || []).slice() };
      salvarPapel();
      desenharPontosTraidor();
      abrirPapelSecreto();   // a carta chega 1 vez; depois ele reabre segurando o selo
    } else if (r.sorteado) {
      papelInfo = { papel: 'fiel' };   // definitivo: nunca mais pergunta
      salvarPapel();
    }
    // sorteado=false: a sala ainda esta se formando; o proximo pulso pergunta de novo
  }).catch(() => {});
}
function abrirPapelSecreto() {
  if (!papelInfo || papelInfo.papel !== 'traidor') return;
  $('papel-titulo').textContent = TEXTOS.papel_titulo || 'UMA CARTA SÓ SUA';
  $('papel-aviso').textContent = TEXTOS.papel_aviso || 'Chegou uma carta pro seu ouvido. Leia sozinho, longe dos outros.';
  $('papel-texto').textContent = TEXTOS.papel_traidor || 'Leve o grupo aos pontos vermelhos do seu mapa, sem que ninguém perceba.';
  atualizarProgressoPapel();
  $('papel-conteudo').classList.add('oculto');
  $('papel-revelar').textContent = TEXTOS.papel_revelar || 'Estou sozinho. Abrir.';
  $('papel-fechar').textContent = TEXTOS.papel_fechar || 'Queimar a carta';
  $('papel-revelar').classList.remove('oculto');
  $('papel-fechar').classList.add('oculto');
  $('papel-secreto').classList.remove('oculto');
}
function atualizarProgressoPapel() {
  if (!papelInfo || papelInfo.papel !== 'traidor') return;
  const rot = TEXTOS.odio_rotulo || 'Fogos acesos';
  $('papel-progresso').textContent = rot + ': ' + (papelInfo.batidos || []).length + ' de ' + (papelInfo.pontos || []).length;
}
function desenharPontosTraidor() {
  if (!mapa || !papelInfo || papelInfo.papel !== 'traidor') return;
  (papelInfo.pontos || []).forEach((pt) => {
    if (marcadoresTraidor[pt.id]) return;
    const batido = (papelInfo.batidos || []).indexOf(pt.id) >= 0;
    const ic = L.divIcon({ className: '', html: '<div class="ponto-traidor' + (batido ? ' batido' : '') + '"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    const m = L.marker([pt.lat, pt.lng], { icon: ic, zIndexOffset: 620, interactive: true }).addTo(mapa);
    const rotulo = (TEXTOS.traidor_pontos_rotulo || 'Leve o grupo até aqui') + (pt.nota ? ': ' + pt.nota : '');
    m.bindTooltip(rotulo, { direction: 'top', offset: [0, -10] });
    marcadoresTraidor[pt.id] = m;
  });
}
function atualizarMarcadorTraidor(id) {
  const m = marcadoresTraidor[id];
  if (!m) return;
  const el = m.getElement();
  if (el) { const d = el.querySelector('.ponto-traidor'); if (d) d.classList.add('batido'); }
}
function verificarPontosTraidor() {
  if (!papelInfo || papelInfo.papel !== 'traidor' || !posAtual) return;
  (papelInfo.pontos || []).forEach((pt) => {
    if ((papelInfo.batidos || []).indexOf(pt.id) >= 0) return;
    const folga = Math.min(posAtual.acc || 0, 20);
    if (distanciaAoCorredorM(posAtual, [[pt.lat, pt.lng]]) <= 30 + folga) {
      traidorFixes[pt.id] = (traidorFixes[pt.id] || 0) + 1;
      if (traidorFixes[pt.id] >= 2) baterPontoTraidor(pt);   // 2 fixes seguidos: presenca real, nao ruido
    } else {
      traidorFixes[pt.id] = 0;
    }
  });
}
function baterPontoTraidor(pt) {
  if ((papelInfo.batidos || []).indexOf(pt.id) >= 0) return;
  papelInfo.batidos.push(pt.id);
  salvarPapel();
  atualizarMarcadorTraidor(pt.id);
  atualizarProgressoPapel();
  toast(TEXTOS.traidor_toast_ponto || 'Um fogo aceso. Ninguém viu.', 4000);
  enviarPontoTraidor(pt.id);
}
function enviarPontoTraidor(id) {
  rpcSup('peula_traidor_ponto', { p_sala: sala, p_disp: admDispId(), p_ponto: id })
    .catch(() => { if (traidorPendentes.indexOf(id) < 0) traidorPendentes.push(id); });
}
function reenviarPontosTraidor() {
  if (!traidorPendentes.length) return;
  const fila = traidorPendentes.slice();
  traidorPendentes = [];
  fila.forEach((id) => enviarPontoTraidor(id));
}
function consultarRevelacao() {
  if (window.SOLO || !sala || !rotaAtiva) return;
  rpcSup('peula_revelacao', { p_sala: sala, p_total: rotaAtiva.etapas.length }).then((r) => {
    if (!r || !r.teve) return;
    const el = $('revelacao-traidor');
    if (!el) return;
    const modelo = (r.odio > 0)
      ? (TEXTOS.revelacao_com_traidor || 'Entre vocês, {nome} servia ao ódio, e acendeu {n} fogo(s).')
      : (TEXTOS.revelacao_sem_odio || '{nome} recebeu a ordem de acender o ódio. Não conseguiu.');
    $('revelacao-traidor-texto').textContent = modelo.split('{nome}').join(r.nome).split('{n}').join(String(r.odio));
    el.classList.remove('oculto');
  }).catch(() => {});
}

// ---------- início ----------
init();
