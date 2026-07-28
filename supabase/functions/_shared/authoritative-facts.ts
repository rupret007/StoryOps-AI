import type { SupabaseClient } from '@supabase/supabase-js';
import type { TrustedFact } from '../../../src/core/ai/contracts.ts';

type FactSource = {
  table: string;
  select: string;
  observedAtFields: string[];
  limit?: number;
};

const sources: readonly FactSource[] = [
  {
    table: 'leads',
    select:
      'id,status,source,customer_id,property_id,service_interest,requested_timing,qualification_summary,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  {
    table: 'customers',
    select:
      'id,display_name,email,phone,lifecycle,preferred_contact_channel,do_not_contact,tax_exempt,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  {
    table: 'properties',
    select:
      'id,customer_id,name,property_type,service_address,known_hazards,stories,latitude,longitude,geocode_confidence,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  {
    table: 'property_measurements',
    select:
      'id,property_id,kind,label,value,unit,source,measured_at,confidence,verified_by_human,source_asset_ids,updated_at,version',
    observedAtFields: ['updated_at', 'measured_at'],
  },
  {
    table: 'photo_analyses',
    select:
      'id,property_id,purpose,overall_confidence,unknowns,disposition,analyzed_at,injection_signals',
    observedAtFields: ['analyzed_at'],
  },
  {
    table: 'price_books',
    select:
      'id,name,version_label,status,effective_from,effective_until,company_minimum,default_tax_rate_pct,margin_floor_pct,automatic_discount_limit_pct,deposit_kind,deposit_value,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  {
    table: 'estimates',
    select:
      'id,estimate_number,customer_id,property_id,price_book_id,price_book_version,status,service_subtotal,travel_fee,discount,tax,total,deposit_required,estimated_cost,estimated_margin_pct,duration_minutes,calculation_version,calculation_issues,calculated_at,updated_at,version',
    observedAtFields: ['updated_at', 'calculated_at'],
  },
  {
    table: 'estimate_lines',
    select:
      'id,estimate_id,line_kind,service_code,add_on_code,description,quantity,unit,unit_price,multiplier,subtotal,taxable,estimated_cost,source_measurement_ids,sort_order,created_at',
    observedAtFields: ['created_at'],
  },
  {
    table: 'quotes',
    select:
      'id,quote_number,estimate_id,customer_id,property_id,status,valid_until,terms_version,total,deposit_required,sent_at,accepted_at,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  {
    table: 'jobs',
    select:
      'id,job_number,quote_id,customer_id,property_id,status,priority,service_codes,estimated_duration_minutes,estimated_revenue,estimated_cost,assigned_crew_id,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  {
    table: 'visits',
    select:
      'id,job_id,sequence,status,starts_at,ends_at,crew_id,route_check_id,weather_check_id,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  {
    table: 'invoices',
    select:
      'id,invoice_number,customer_id,job_id,status,provider_invoice_id,issue_date,due_date,subtotal,tax,total,amount_paid,balance_due,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  {
    table: 'payments',
    select:
      'id,invoice_id,customer_id,provider,provider_payment_id,payment_type,status,amount,processed_at,updated_at,version',
    observedAtFields: ['updated_at', 'processed_at'],
  },
  {
    table: 'consent_records',
    select:
      'id,customer_id,lead_id,channel,purpose,status,captured_at,capture_method,disclosure_version,withdrawn_at,updated_at,version',
    observedAtFields: ['updated_at', 'captured_at'],
  },
];

function observedAt(row: Record<string, unknown>, fields: string[], fallback: string): string {
  for (const field of fields) {
    if (typeof row[field] === 'string') return row[field] as string;
  }
  return fallback;
}

export async function resolveAuthoritativeFacts(
  client: SupabaseClient,
  companyId: string,
): Promise<TrustedFact[]> {
  const resolvedAt = new Date().toISOString();
  const results = await Promise.all(
    sources.map(async (source) => {
      const { data, error } = await client
        .from(source.table)
        .select(source.select)
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .limit(source.limit ?? 100);
      if (error) {
        throw new Error(
          `Authoritative ${source.table} facts could not be resolved: ${error.message}`,
        );
      }
      return (data ?? []).map((raw) => {
        const row = raw as unknown as Record<string, unknown>;
        const id = typeof row.id === 'string' ? row.id : undefined;
        if (!id) throw new Error(`Authoritative ${source.table} fact has no stable ID.`);
        return {
          id: `${source.table}:${id}`,
          name: source.table,
          value: row,
          source: 'database' as const,
          observedAt: observedAt(row, source.observedAtFields, resolvedAt),
        };
      });
    }),
  );
  return results.flat();
}
