-- La app lee su propia suscripción; solo el servidor valida y cambia su estado.
drop policy if exists "Cada quien ve su propia suscripción" on public.subscriptions;
create policy subscriptions_own_read on public.subscriptions for select to authenticated using ((select auth.uid()) = user_id);
create policy subscriptions_own_delete on public.subscriptions for delete to authenticated using ((select auth.uid()) = user_id);
revoke insert, update on public.subscriptions from public, anon, authenticated;
grant select, delete on public.subscriptions to authenticated;
-- Función interna de DDL: no debe ejecutarse desde clientes públicos.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
-- Caché exclusiva del servidor: sin acceso de cliente ni políticas públicas.
alter table public.cache_persistente enable row level security;
revoke all on public.cache_persistente from public, anon, authenticated;
