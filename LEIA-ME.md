# As Portas de Jerusalém (peula 68)

App web de caça ao tesouro pela Cidade Velha. Estático, sem backend: abre por link ou QR, roda em qualquer celular, funciona com sinal ruim. Todo o conteúdo editável fica em `conteudo/`; você nunca precisa tocar no código.

## Mapa dos arquivos

| Arquivo | O que é | Você edita? |
|---|---|---|
| `conteudo/rotas.json` | As 4 rotas: senhas, corredores, textos, missões | SIM, é o coração |
| `conteudo/textos.json` | Portão, avisos, convergência final | SIM |
| `conteudo/config-mapa.json` | Imagem do mapa e os 2 cantos georreferenciados | SIM, após o scouting |
| `img/mapa-jerusalem-68.png` | A imagem do mapa (hoje um esboço provisório) | Trocar pela arte final |
| `index.html`, `css/`, `js/` | As telas e a lógica | Não |
| `sw.js` | Cache offline | Só o número `VERSAO` (ver abaixo) |
| `vendor/` | Leaflet e fonte, guardados localmente para funcionar offline | Não |

## Rodar no computador

Na pasta `peula-68-app`, rode `py -m http.server 8068` e abra `http://localhost:8068`. Precisa ser por servidor (não clicando no index.html), porque o app carrega os JSON e registra o cache offline.

## Testar sem sair de casa

- `?mock=31.7768,35.2277` na URL simula o GPS naquele ponto (o painel de calibração ganha botões de "andar").
- `?debug=1` abre o painel de calibração: posição ao vivo, distância ao corredor, corredores desenhados no mapa, ajuste fino dos cantos da imagem e botão que copia o `config-mapa.json` pronto.
- `?reset=1` apaga o progresso do celular e volta ao portão. No campo, sem mexer em URL: 7 toques seguidos no cabeçalho do mapa abrem a calibração, que tem o botão de reiniciar.

## As senhas (placeholders atuais)

- Entrada por seita: PERGUNTA (Fariseus), ALTAR (Saduceus), DESERTO (Essênios), PUNHAL (Zelotes).
- Desbloqueio de etapas: veja `senha_desbloqueio` em cada etapa do `rotas.json`.
- Maiúsculas, minúsculas e acentos não importam na digitação.

## Depois do scouting

1. Ande cada rota anotando os pontos: no Google Maps, toque e segure (ou botão direito) e copie as coordenadas, por exemplo `31.77675, 35.22755`.
2. Em `rotas.json`, cole cada ponto no `corredor` da etapa como `[31.77675, 35.22755]`. O corredor aceita quantos pontos quiser; mais pontos, caminho mais fiel.
3. `raio_m` é a tolerância em metros ao redor do corredor. Com o GPS ruim da Cidade Velha, 40 a 60 é um bom valor. O app ainda soma uma folga automática quando o sinal está impreciso.
4. Troque os `texto_diwan`, `missao`, senhas e fragmentos.
5. Publique de novo. Conteúdo JSON atualiza nos celulares sem passo extra.

## Trocar a imagem do mapa pela arte final

1. Gere a arte com norte para cima.
2. A proporção precisa casar com os cantos do `config-mapa.json`. Fórmula: largura em metros = (lon SE - lon NO) x 111320 x cos(latitude média); altura em metros = (lat NO - lat SE) x 110574. Com os cantos atuais a proporção é aproximadamente 1514 x 1659 (largura x altura), ou seja, imagem tipo 1870 x 2048.
3. Salve como `img/mapa-jerusalem-68.png` (ou outro nome, ajustando `imagem` no config).
4. Suba o `VERSAO` do `sw.js` (por exemplo de `p68-v1` para `p68-v2`), senão os celulares que já visitaram continuam com a imagem velha do cache.
5. No local, abra com `?debug=1` e empurre os cantos até a tocha cair no lugar certo. Copie o JSON gerado e cole no `config-mapa.json`.

## Publicar

Netlify (mais simples): arraste a pasta `peula-68-app` inteira em app.netlify.com/drop. Sai uma URL https pronta para virar QR code. Vercel funciona igual. O GPS só funciona em https, então nada de servir por http em produção.

## Regra de ouro do offline

- Editou `conteudo/*.json`: só publicar. Chega sozinho nos celulares.
- Editou código, imagem ou fonte: publicar E subir o `VERSAO` no `sw.js`.
