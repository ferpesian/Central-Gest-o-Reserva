-- Central da Gestão — Reserva Imob BC
-- Rode este arquivo inteiro no Supabase: SQL Editor > New query > colar > Run.
-- Troque os e-mails abaixo se forem diferentes.

-- 1. Perfis (quem pode entrar e com qual papel)
create table if not exists public.perfis (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text not null,
  email text unique,
  papel text not null default 'gestor' check (papel in ('admin','gestor'))
);

-- 2. Registros do app (todas as abas usam esta tabela)
create table if not exists public.registros (
  col text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  owner uuid not null default auth.uid() references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
create index if not exists registros_col_idx on public.registros(col);

-- 3. Funções auxiliares
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfis where id = auth.uid() and papel = 'admin');
$$;
create or replace function public.tem_perfil() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfis where id = auth.uid());
$$;

-- Dono não muda (só o admin pode transferir) e data de atualização automática
create or replace function public.registros_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then new.owner := old.owner; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_registros_upd on public.registros;
create trigger trg_registros_upd before update on public.registros
for each row execute function public.registros_before_update();

-- Perfil criado automaticamente quando o usuário é cadastrado
create or replace function public.novo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.perfis (id, nome, email, papel)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nome',
      case lower(new.email)
        when 'fernando@reservaimob.com.br' then 'Fernando'
        when 'gollo@reservaimob.com.br' then 'Luiz'
        when 'alan@reservaimob.com.br' then 'Alan'
        else split_part(new.email, '@', 1) end),
    lower(new.email),
    case when lower(new.email) = 'fernando@reservaimob.com.br' then 'admin' else 'gestor' end
  ) on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists trg_novo_usuario on auth.users;
create trigger trg_novo_usuario after insert on auth.users
for each row execute function public.novo_usuario();

-- 4. Segurança (RLS)
alter table public.perfis enable row level security;
alter table public.registros enable row level security;

drop policy if exists perfis_ver on public.perfis;
create policy perfis_ver on public.perfis for select to authenticated using (public.tem_perfil());
drop policy if exists perfis_admin on public.perfis;
create policy perfis_admin on public.perfis for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Todos os perfis veem tudo
drop policy if exists reg_ver on public.registros;
create policy reg_ver on public.registros for select to authenticated using (public.tem_perfil());
-- Cada um cria registros em seu nome
drop policy if exists reg_criar on public.registros;
create policy reg_criar on public.registros for insert to authenticated
  with check (public.tem_perfil() and (owner = auth.uid() or public.is_admin()));
-- Luiz e Alan editam/excluem só os deles; Fernando (admin) edita tudo
drop policy if exists reg_editar on public.registros;
create policy reg_editar on public.registros for update to authenticated
  using (owner = auth.uid() or public.is_admin())
  with check (owner = auth.uid() or public.is_admin());
drop policy if exists reg_excluir on public.registros;
create policy reg_excluir on public.registros for delete to authenticated
  using (owner = auth.uid() or public.is_admin());

-- 5. Atualização em tempo real entre os usuários
do $$ begin
  alter publication supabase_realtime add table public.registros;
exception when duplicate_object then null; end $$;

-- 6. Usuários já cadastrados antes deste script ganham perfil
insert into public.perfis (id, nome, email, papel)
select u.id,
  case lower(u.email) when 'fernando@reservaimob.com.br' then 'Fernando' when 'gollo@reservaimob.com.br' then 'Luiz' when 'alan@reservaimob.com.br' then 'Alan' else split_part(u.email,'@',1) end,
  lower(u.email),
  case when lower(u.email) = 'fernando@reservaimob.com.br' then 'admin' else 'gestor' end
from auth.users u on conflict (id) do nothing;
