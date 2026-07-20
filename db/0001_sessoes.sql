-- Sessao de grupo AO VIVO: estado compartilhado por sala (a "senha do dia" do grupo).
-- Todos do grupo leem a etapa atual; quando um digita a senha da proxima etapa, a
-- sala avanca no servidor e os outros revelam a proxima carta na proxima consulta.
-- Schema ISOLADO "peula" (ja existe): tabela dark para a API, tudo via RPC public,
-- mesmo padrao seguro de peula.inscricoes. Idempotente.

create schema if not exists peula;

create table if not exists peula.sessoes (
  sala          text primary key,
  corrente      text        not null,
  etapa         int         not null default 1,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
comment on table peula.sessoes is
  'Estado ao vivo do grupo (sala = senha do dia). Followers leem e revelam a proxima carta.';

alter table peula.sessoes enable row level security;
-- Sem policy/grant para anon: dark. Leitura e escrita so pelas RPC public abaixo.

-- Entrar/criar a sala (idempotente). Retorna a etapa atual e a corrente.
create or replace function public.peula_entrar(p_sala text, p_corrente text)
returns table(etapa int, corrente text)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(btrim(p_sala),'') = '' then raise exception 'sala vazia'; end if;
  insert into peula.sessoes (sala, corrente)
  values (lower(btrim(p_sala)), lower(btrim(p_corrente)))
  on conflict (sala) do update set atualizado_em = now();
  return query
    select s.etapa, s.corrente from peula.sessoes s where s.sala = lower(btrim(p_sala));
end $$;

-- Ler o estado (a etapa atual e a corrente da sala). Null se a sala nao existe.
create or replace function public.peula_estado(p_sala text)
returns table(etapa int, corrente text)
language sql security definer set search_path = '' as $$
  select s.etapa, s.corrente from peula.sessoes s where s.sala = lower(btrim(p_sala));
$$;

-- Avancar: SO aceita etapa = atual + 1 (monotonico; sem pulo, sem reset, sem grief).
-- O cliente valida a senha localmente antes de chamar; o servidor so deixa dar 1 passo.
create or replace function public.peula_avancar(p_sala text, p_para int)
returns int language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  update peula.sessoes set etapa = p_para, atualizado_em = now()
    where sala = lower(btrim(p_sala)) and p_para = etapa + 1 and p_para between 2 and 50;
  select etapa into v from peula.sessoes where sala = lower(btrim(p_sala));
  return coalesce(v, 1);
end $$;

revoke all on function public.peula_entrar(text, text) from public;
revoke all on function public.peula_estado(text) from public;
revoke all on function public.peula_avancar(text, int) from public;
grant execute on function public.peula_entrar(text, text) to anon;
grant execute on function public.peula_estado(text) to anon;
grant execute on function public.peula_avancar(text, int) to anon;

notify pgrst, 'reload schema';
