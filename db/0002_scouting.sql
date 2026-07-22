-- Diario de scouting do modo ADM (levantamento das rotas em campo).
-- O app coleta pontos com foto, comentario e etiqueta no aparelho (IndexedDB) e,
-- quando pega wifi, sobe tudo para ca. Mesmo schema isolado "peula" e mesmo padrao
-- dark + RPC de 0001_sessoes.sql: as tabelas nao tem grant para anon; o app (anon)
-- so ESCREVE via as RPC public security definer abaixo (upsert idempotente por id).
-- A leitura (para montar as rotas) e feita fora do app, so com a service_role.
-- Idempotente: pode rodar de novo sem quebrar nada.

create schema if not exists peula;

-- ----- tabelas -----
create table if not exists peula.scouting_pontos (
  id            uuid primary key,
  n             int,
  lat           double precision not null,
  lng           double precision not null,
  acc           double precision,
  nota          text        not null default '',
  etiqueta      text        not null default '',
  rota          text        not null default '',  -- nome da rota levantada (ex.: "Tapuz A")
  dispositivo   text,                         -- id anonimo do aparelho (agrupa quem levantou)
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  recebido_em   timestamptz not null default now()
);
comment on table peula.scouting_pontos is
  'Pontos do scouting de campo (modo ADM). Upsert por id via RPC anon; leitura so service_role.';

create table if not exists peula.scouting_fotos (
  id          uuid primary key,
  ponto_id    uuid        not null references peula.scouting_pontos(id) on delete cascade,
  mime        text        not null default 'image/jpeg',
  dados       bytea       not null,           -- a foto ja comprimida (JPEG)
  criado_em   timestamptz not null default now(),
  recebido_em timestamptz not null default now()
);
create index if not exists scouting_fotos_ponto on peula.scouting_fotos(ponto_id);

alter table peula.scouting_pontos enable row level security;
alter table peula.scouting_fotos  enable row level security;
-- dark: sem policy/grant para anon. Escrita e leitura so pelas RPC abaixo.

-- ----- escrita (anon): upsert de um ponto -----
create or replace function public.peula_scouting_ponto(
  p_id uuid, p_n int, p_lat double precision, p_lng double precision,
  p_acc double precision, p_nota text, p_etiqueta text, p_rota text,
  p_dispositivo text, p_criado_em timestamptz, p_atualizado_em timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_id is null or p_lat is null or p_lng is null then
    raise exception 'ponto invalido';
  end if;
  insert into peula.scouting_pontos as s
    (id, n, lat, lng, acc, nota, etiqueta, rota, dispositivo, criado_em, atualizado_em, recebido_em)
  values
    (p_id, p_n, p_lat, p_lng, p_acc, left(coalesce(p_nota,''), 4000), left(coalesce(p_etiqueta,''), 40),
     left(coalesce(p_rota,''), 80), left(coalesce(p_dispositivo,''), 80), coalesce(p_criado_em, now()), coalesce(p_atualizado_em, now()), now())
  on conflict (id) do update set
    n = excluded.n, lat = excluded.lat, lng = excluded.lng, acc = excluded.acc,
    nota = excluded.nota, etiqueta = excluded.etiqueta, rota = excluded.rota,
    atualizado_em = excluded.atualizado_em, recebido_em = now();
end $$;

-- ----- escrita (anon): upsert de uma foto (recebe base64, guarda bytea) -----
create or replace function public.peula_scouting_foto(
  p_id uuid, p_ponto_id uuid, p_mime text, p_dados_b64 text
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_bytes bytea;
begin
  if p_id is null or p_ponto_id is null or coalesce(p_dados_b64,'') = '' then
    raise exception 'foto invalida';
  end if;
  v_bytes := decode(p_dados_b64, 'base64');
  if octet_length(v_bytes) > 4000000 then   -- teto de ~4MB por foto (as fotos ja vem comprimidas)
    raise exception 'foto grande demais';
  end if;
  insert into peula.scouting_fotos as f (id, ponto_id, mime, dados, recebido_em)
  values (p_id, p_ponto_id, coalesce(p_mime,'image/jpeg'), v_bytes, now())
  on conflict (id) do nothing;   -- foto e imutavel; se ja subiu, nao repete
end $$;

-- ----- leitura (service_role): dump dos pontos em json, com contagem de fotos -----
create or replace function public.peula_scouting_dump()
returns json
language sql security definer set search_path = '' as $$
  select coalesce(json_agg(t order by t.recebido_em), '[]'::json) from (
    select p.*, (select count(*) from peula.scouting_fotos f where f.ponto_id = p.id) as fotos
    from peula.scouting_pontos p
  ) t;
$$;

-- ----- leitura (service_role): fotos de um ponto (base64) para baixar -----
create or replace function public.peula_scouting_foto_dados(p_ponto_id uuid)
returns table(id uuid, mime text, dados_b64 text)
language sql security definer set search_path = '' as $$
  select f.id, f.mime, encode(f.dados, 'base64')
  from peula.scouting_fotos f where f.ponto_id = p_ponto_id order by f.criado_em;
$$;

-- ----- manutencao (service_role): zera o levantamento (cascade apaga as fotos) -----
create or replace function public.peula_scouting_limpar()
returns void
language sql security definer set search_path = '' as $$
  delete from peula.scouting_pontos;
$$;

-- ----- grants: escrita para anon, leitura e manutencao so para service_role -----
revoke all on function public.peula_scouting_ponto(uuid,int,double precision,double precision,double precision,text,text,text,text,timestamptz,timestamptz) from public;
revoke all on function public.peula_scouting_foto(uuid,uuid,text,text) from public;
revoke all on function public.peula_scouting_dump() from public;
revoke all on function public.peula_scouting_foto_dados(uuid) from public;
revoke all on function public.peula_scouting_limpar() from public;

grant execute on function public.peula_scouting_ponto(uuid,int,double precision,double precision,double precision,text,text,text,text,timestamptz,timestamptz) to anon;
grant execute on function public.peula_scouting_foto(uuid,uuid,text,text) to anon;
grant execute on function public.peula_scouting_dump() to service_role;
grant execute on function public.peula_scouting_foto_dados(uuid) to service_role;
grant execute on function public.peula_scouting_limpar() to service_role;

notify pgrst, 'reload schema';
