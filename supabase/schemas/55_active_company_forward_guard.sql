-- Forward-install the active-company mutation boundary on tenant tables added
-- after the original migration-35 catalog sweep.
--
-- Existing enabled guards are left untouched. A disabled trigger with the
-- canonical name is replaced so rerunning this migration is idempotent and
-- cannot leave a tenant table apparently guarded but operationally unprotected.

do $$
declare
  relation_name text;
begin
  for relation_name in
    select column_record.table_name
    from information_schema.columns column_record
    join information_schema.tables table_record
      on table_record.table_schema = column_record.table_schema
     and table_record.table_name = column_record.table_name
    where column_record.table_schema = 'public'
      and column_record.column_name = 'company_id'
      and table_record.table_type = 'BASE TABLE'
      and not exists (
        select 1
        from pg_trigger trigger_record
        join pg_class relation_record
          on relation_record.oid = trigger_record.tgrelid
        join pg_namespace namespace_record
          on namespace_record.oid = relation_record.relnamespace
        where namespace_record.nspname = 'public'
          and relation_record.relname = column_record.table_name
          and trigger_record.tgname =
            'storyops_active_company_mutation_gate'
          and not trigger_record.tgisinternal
          and trigger_record.tgenabled <> 'D'
      )
    order by column_record.table_name
  loop
    execute format(
      'drop trigger if exists storyops_active_company_mutation_gate on public.%I',
      relation_name
    );
    execute format(
      'create trigger storyops_active_company_mutation_gate
         before insert or update or delete on public.%I
         for each row
         execute function public.assert_active_company_for_authenticated_mutation()',
      relation_name
    );
  end loop;
end;
$$;
