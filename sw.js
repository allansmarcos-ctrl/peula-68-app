/* Service worker: resiliência offline com sinal ruim.
   Estratégia:
   - Arquivos do app (código, imagem do mapa, fontes): CACHE-FIRST.
     Mudou código ou imagem? Suba o número de VERSAO abaixo e publique.
   - JSON de conteudo/ (rotas, textos, config): NETWORK-FIRST com cache de reserva.
     Assim uma edição pós-scouting chega aos celulares sem trocar versão,
     e com sinal ruim vale a última cópia boa. */

const VERSAO = 'p68-v7';

const NUCLEO = [
  './',
  './index.html',
  './css/estilo.css',
  './js/app.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/fontes/cinzel-700.woff2',
  './img/mapa-jerusalem-68.png',
  './img/icone-192.png',
  './img/icone-512.png',
  './manifest.webmanifest',
  './conteudo/textos.json',
  './conteudo/config-mapa.json',
  './conteudo/rotas.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSAO)
      .then(async (c) => {
        await c.addAll(NUCLEO);
        // fotos das etapas (rotas.json) entram no precache com melhor esforço:
        // uma foto faltando não pode impedir o app de funcionar offline
        try {
          const r = await fetch('./conteudo/rotas.json', { cache: 'no-cache' });
          const dados = await r.json();
          const fotos = [];
          (dados.rotas || []).forEach((rt) => (rt.etapas || []).forEach((et) => (et.fotos || []).forEach((f) => fotos.push(f))));
          await Promise.all(fotos.map((f) => c.add(f).catch(() => null)));
        } catch (err) { /* sem rotas.json agora, as fotos entram no uso */ }
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;

  const url = new URL(req.url);
  const ehConteudo = url.pathname.includes('/conteudo/');

  if (ehConteudo) {
    // network-first com revalidação: conteúdo editado chega; sem rede, vale a última cópia
    e.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(VERSAO).then((c) => c.put(req, clone));
          }
          return resp;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // cache-first para o resto (só atualiza com bump de VERSAO)
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((resp) => {
        if (resp.ok && url.origin === self.location.origin) {
          const clone = resp.clone();
          caches.open(VERSAO).then((c) => c.put(req, clone));
        }
        return resp;
      }).catch(() => {
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
