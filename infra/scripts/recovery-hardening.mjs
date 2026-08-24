import { createHash } from 'node:crypto';

export const REQUIRED_STORYOPS_MIGRATIONS = Object.freeze([
  '20260728000000',
  '20260728010000',
  '20260728020000',
  '20260728030000',
  '20260728040000',
  '20260728050000',
  '20260728060000',
  '20260728070000',
  '20260728080000',
  '20260728090000',
  '20260728100000',
  '20260728110000',
  '20260728120000',
  '20260728130000',
  '20260728140000',
  '20260728150000',
  '20260728160000',
  '20260728170000',
  '20260728180000',
  '20260728190000',
  '20260728200000',
  '20260728210000',
  '20260728220000',
  '20260728230000',
  '20260728240000',
  '20260728250000',
  '20260728260000',
  '20260728270000',
  '20260728280000',
  '20260728290000',
  '20260728300000',
  '20260728310000',
  '20260728320000',
  '20260728330000',
  '20260728340000',
  '20260728350000',
  '20260728360000',
  '20260728370000',
  '20260728380000',
  '20260728390000',
  '20260728400000',
  '20260728410000',
  '20260728420000',
  '20260728430000',
  '20260728440000',
  '20260728450000',
  '20260728460000',
  '20260728470000',
  '20260728480000',
  '20260728490000',
  '20260728500000',
  '20260728510000',
  '20260728520000',
  '20260728530000',
  '20260728540000',
  '20260728550000',
  '20260728560000',
  '20260728570000',
  '20260728580000',
  '20260728590000',
  '20260728600000',
  '20260728610000',
  '20260728620000',
  '20260728630000',
  '20260728640000',
  '20260728650000',
  '20260728660000',
  '20260728670000',
]);

export const REQUIRED_STORYOPS_MIGRATION = REQUIRED_STORYOPS_MIGRATIONS.at(-1);

export const STORYOPS_SCHEMA_SENTINELS = Object.freeze([
  'public.companies',
  'public.audit_events',
  'public.post_service_followups',
  'public.media_upload_attestations',
  'public.scheduling_evidence_receipts',
  'public.customer_portal_requests',
  'public.scheduling_reconciliation_cases',
  'public.scheduling_calendar_booking_attempts',
  'public.job_actual_cost_snapshots',
  'public.automation_runs',
  'public.owner_briefings',
  'public.customer_quote_change_requests',
  'public.payment_allocation_conflicts',
  'public.payment_checkout_retirements',
  'public.customer_quote_acceptances',
  'public.lead_intake_operational_dispositions',
  'public.transactional_delivery_attempts',
  'public.field_change_requests',
  'public.recurring_due_occurrences',
  'public.sds_registration_requests',
  'public.sds_upload_attestations',
  'public.integration_environment_probe_results',
  'public.company_launch_authorization_events',
  'public.trusted_pilot_verification_runs',
  'public.dispatch_clearance_receipts',
  'public.dispatch_clearance_consumptions',
  'public.identity_provisioning_targets',
  'public.identity_provisioning_commands',
  'public.identity_invitation_attempts',
  'public.property_geocode_candidates',
  'private.storyops_private_worker_heartbeats',
  'private.storyops_private_worker_readiness_snapshots',
]);

const STORYOPS_SCHEMA_PATTERNS = Object.freeze([
  {
    name: 'public.companies',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"companies"|companies)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.audit_events',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"audit_events"|audit_events)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.post_service_followups',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"post_service_followups"|post_service_followups)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.media_upload_attestations',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"media_upload_attestations"|media_upload_attestations)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.scheduling_evidence_receipts',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"scheduling_evidence_receipts"|scheduling_evidence_receipts)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.customer_portal_requests',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"customer_portal_requests"|customer_portal_requests)(?![a-z0-9_])/iu,
  },
  {
    name: 'role-offboarding active-membership guard',
    pattern:
      /Portal authorization requires both the exact portal mapping and a current active customer membership\./u,
  },
  {
    name: 'public.scheduling_reconciliation_cases',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"scheduling_reconciliation_cases"|scheduling_reconciliation_cases)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.scheduling_calendar_booking_attempts',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"scheduling_calendar_booking_attempts"|scheduling_calendar_booking_attempts)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.job_actual_cost_snapshots',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"job_actual_cost_snapshots"|job_actual_cost_snapshots)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.automation_runs',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"automation_runs"|automation_runs)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.owner_briefings',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"owner_briefings"|owner_briefings)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.customer_quote_change_requests',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"customer_quote_change_requests"|customer_quote_change_requests)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.payment_allocation_conflicts',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"payment_allocation_conflicts"|payment_allocation_conflicts)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.payment_checkout_retirements',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"payment_checkout_retirements"|payment_checkout_retirements)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.customer_quote_acceptances',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"customer_quote_acceptances"|customer_quote_acceptances)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.lead_intake_operational_dispositions',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"lead_intake_operational_dispositions"|lead_intake_operational_dispositions)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.transactional_delivery_attempts',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"transactional_delivery_attempts"|transactional_delivery_attempts)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.field_change_requests',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"field_change_requests"|field_change_requests)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.recurring_due_occurrences',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"recurring_due_occurrences"|recurring_due_occurrences)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.sds_registration_requests',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"sds_registration_requests"|sds_registration_requests)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.sds_upload_attestations',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"sds_upload_attestations"|sds_upload_attestations)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.integration_environment_probe_results',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"integration_environment_probe_results"|integration_environment_probe_results)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.company_launch_authorization_events',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"company_launch_authorization_events"|company_launch_authorization_events)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.trusted_pilot_verification_runs',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"trusted_pilot_verification_runs"|trusted_pilot_verification_runs)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.dispatch_clearance_receipts',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"dispatch_clearance_receipts"|dispatch_clearance_receipts)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.dispatch_clearance_consumptions',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"dispatch_clearance_consumptions"|dispatch_clearance_consumptions)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.identity_provisioning_targets',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"identity_provisioning_targets"|identity_provisioning_targets)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.identity_provisioning_commands',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"identity_provisioning_commands"|identity_provisioning_commands)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.identity_invitation_attempts',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"identity_invitation_attempts"|identity_invitation_attempts)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.property_geocode_candidates',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"property_geocode_candidates"|property_geocode_candidates)(?![a-z0-9_])/iu,
  },
  {
    name: 'private.storyops_private_worker_heartbeats',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"private"|private)\s*\.\s*(?:"storyops_private_worker_heartbeats"|storyops_private_worker_heartbeats)(?![a-z0-9_])/iu,
  },
  {
    name: 'private.storyops_private_worker_readiness_snapshots',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"private"|private)\s*\.\s*(?:"storyops_private_worker_readiness_snapshots"|storyops_private_worker_readiness_snapshots)(?![a-z0-9_])/iu,
  },
  {
    name: 'private.storyops_incident_stop_capabilities',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"private"|private)\s*\.\s*(?:"storyops_incident_stop_capabilities"|storyops_incident_stop_capabilities)(?![a-z0-9_])/iu,
  },
  {
    name: 'private.storyops_incident_close_capabilities',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"private"|private)\s*\.\s*(?:"storyops_incident_close_capabilities"|storyops_incident_close_capabilities)(?![a-z0-9_])/iu,
  },
  {
    name: 'dispatch clearance current-origin v2 contract',
    pattern: /\bstoryops-dispatch-current-origin-v1\b/iu,
  },
  {
    name: 'media-assets incident evidence guard',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"media_assets_incident_evidence_guard"|media_assets_incident_evidence_guard)(?![a-z0-9_])/iu,
  },
  {
    name: 'incidents safe-update command guard',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"aa_incidents_safe_update_guard"|aa_incidents_safe_update_guard)(?![a-z0-9_])/iu,
  },
  {
    name: 'open-incident stop-work media guard',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"media_assets_open_incident_stop_work"|media_assets_open_incident_stop_work)(?![a-z0-9_])/iu,
  },
  {
    name: 'dispatch current-origin consumption guard',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"dispatch_clearance_consumption_current_origin_guard"|dispatch_clearance_consumption_current_origin_guard)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.referrals_one_invite_per_source_invoice_idx',
    pattern: /\breferrals_one_invite_per_source_invoice_idx\b/iu,
  },
  {
    name: 'public.get_storyops_setup_state',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"get_storyops_setup_state"|get_storyops_setup_state)\s*\(/iu,
  },
  {
    name: 'public.begin_storyops_post_service_submission',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"begin_storyops_post_service_submission"|begin_storyops_post_service_submission)\s*\(/iu,
  },
  {
    name: 'public.finalize_storyops_media_upload',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"finalize_storyops_media_upload"|finalize_storyops_media_upload)\s*\(/iu,
  },
  {
    name: 'public.finalize_storyops_media_upload_from_edge',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"finalize_storyops_media_upload_from_edge"|finalize_storyops_media_upload_from_edge)\s*\(/iu,
  },
  {
    name: 'public.reserve_storyops_field_media_verification',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"reserve_storyops_field_media_verification"|reserve_storyops_field_media_verification)\s*\(/iu,
  },
  {
    name: 'public.claim_storyops_field_media_verification',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"claim_storyops_field_media_verification"|claim_storyops_field_media_verification)\s*\(/iu,
  },
  {
    name: 'public.complete_storyops_field_media_verification',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"complete_storyops_field_media_verification"|complete_storyops_field_media_verification)\s*\(/iu,
  },
  {
    name: 'private.is_storyops_field_media_canary_object',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"private"|private)\s*\.\s*(?:"is_storyops_field_media_canary_object"|is_storyops_field_media_canary_object)\s*\(/iu,
  },
  {
    name: 'field-media Edge adapter canonical delegation',
    pattern:
      /\bresult\s*:=\s*(?:"public"|public)\s*\.\s*(?:"finalize_storyops_media_upload"|finalize_storyops_media_upload)\s*\(/iu,
  },
  {
    name: 'field-media canary exact Storage predicate link',
    pattern:
      /(?:"private"|private)\s*\.\s*(?:"is_storyops_field_media_canary_object"|is_storyops_field_media_canary_object)\s*\(\s*(?:"target_name"|target_name)\s*\)/iu,
  },
  {
    name: 'public.claim_storyops_scheduling_reconciliation',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"claim_storyops_scheduling_reconciliation"|claim_storyops_scheduling_reconciliation)\s*\(/iu,
  },
  {
    name: 'public.get_storyops_profitability_kpis',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"get_storyops_profitability_kpis"|get_storyops_profitability_kpis)\s*\(/iu,
  },
  {
    name: 'industry-pack scope evidence policy',
    pattern: /\bscope_evidence_policy\b/iu,
  },
  {
    name: 'authoritative reviewed travel-zone mappings',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"validate_travel_zone_configuration"|validate_travel_zone_configuration)\s*\(/iu,
  },
  {
    name: 'public.execute_ai_approved_lead_action',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"execute_ai_approved_lead_action"|execute_ai_approved_lead_action)\s*\(/iu,
  },
  {
    name: 'public.load_service_scope_evidence_policies',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"load_service_scope_evidence_policies"|load_service_scope_evidence_policies)\s*\(/iu,
  },
  {
    name: 'flat/hour pricing evidence support',
    pattern: /pricingUnit['"]?\s*=\s*['"]hour['"][\s\S]{0,300}duration_hours/iu,
  },
  {
    name: 'persist_priced_estimate supporting-measurement provenance',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"persist_priced_estimate"|persist_priced_estimate)\s*\((?=[\s\S]*\bexpected_service_measurement_ids\b)(?=[\s\S]*\bESTIMATE_SUPPORTING_MEASUREMENT_EVIDENCE_MISMATCH\b)/iu,
  },
  {
    name: 'approved actions require an active company',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"enforce_active_company_approved_action_start"|enforce_active_company_approved_action_start)\s*\(/iu,
  },
  {
    name: 'public.load_estimate_scope_evidence_bundle',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"load_estimate_scope_evidence_bundle"|load_estimate_scope_evidence_bundle)\s*\(/iu,
  },
  {
    name: 'estimates_scope_evidence_bundle trigger',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"estimates_scope_evidence_bundle"|estimates_scope_evidence_bundle)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.begin_storyops_ai_office_run',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"begin_storyops_ai_office_run"|begin_storyops_ai_office_run)\s*\(/iu,
  },
  {
    name: 'public.complete_storyops_ai_office_run',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"complete_storyops_ai_office_run"|complete_storyops_ai_office_run)\s*\(/iu,
  },
  {
    name: 'public.fail_storyops_ai_office_run',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"fail_storyops_ai_office_run"|fail_storyops_ai_office_run)\s*\(/iu,
  },
  {
    name: 'public.get_storyops_ai_office_recent',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"get_storyops_ai_office_recent"|get_storyops_ai_office_recent)\s*\(/iu,
  },
  {
    name: 'public.load_storyops_edge_actor',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"load_storyops_edge_actor"|load_storyops_edge_actor)\s*\(/iu,
  },
  {
    name: 'public.load_storyops_ai_fact_rows',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"load_storyops_ai_fact_rows"|load_storyops_ai_fact_rows)\s*\(/iu,
  },
  {
    name: 'public.persist_storyops_photo_analysis',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"persist_storyops_photo_analysis"|persist_storyops_photo_analysis)\s*\(/iu,
  },
  {
    name: 'public.load_storyops_billing_validation',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"load_storyops_billing_validation"|load_storyops_billing_validation)\s*\(/iu,
  },
  {
    name: 'public.load_storyops_scheduling_candidate',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"load_storyops_scheduling_candidate"|load_storyops_scheduling_candidate)\s*\(/iu,
  },
  {
    name: 'public.execute_customer_quote_action',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"execute_customer_quote_action"|execute_customer_quote_action)\s*\(/iu,
  },
  {
    name: 'public.prepare_storyops_invoice_checkout',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"prepare_storyops_invoice_checkout"|prepare_storyops_invoice_checkout)\s*\(/iu,
  },
  {
    name: 'public.resolve_storyops_payment_allocation',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"resolve_storyops_payment_allocation"|resolve_storyops_payment_allocation)\s*\(/iu,
  },
  {
    name: 'public.accept_customer_quote',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"accept_customer_quote"|accept_customer_quote)\s*\(/iu,
  },
  {
    name: 'public.get_storyops_audit_feed',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"get_storyops_audit_feed"|get_storyops_audit_feed)\s*\(/iu,
  },
  {
    name: 'authenticated active-company mutation gate',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"assert_active_company_for_authenticated_mutation"|assert_active_company_for_authenticated_mutation)\s*\(/iu,
  },
  {
    name: 'trusted lead-intake operational disposition',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"record_storyops_lead_intake_operational_disposition"|record_storyops_lead_intake_operational_disposition)\s*\(/iu,
  },
  {
    name: 'public.queue_storyops_transactional_delivery',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"queue_storyops_transactional_delivery"|queue_storyops_transactional_delivery)\s*\(/iu,
  },
  {
    name: 'public.claim_storyops_transactional_delivery',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"claim_storyops_transactional_delivery"|claim_storyops_transactional_delivery)\s*\(/iu,
  },
  {
    name: 'public.record_storyops_pilot_release_evidence',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"record_storyops_pilot_release_evidence"|record_storyops_pilot_release_evidence)\s*\(/iu,
  },
  {
    name: 'public.get_storyops_pilot_release_evidence',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"get_storyops_pilot_release_evidence"|get_storyops_pilot_release_evidence)\s*\(/iu,
  },
  {
    name: 'public.submit_storyops_field_change_request',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"submit_storyops_field_change_request"|submit_storyops_field_change_request)\s*\(/iu,
  },
  {
    name: 'public.publish_storyops_completed_work_evidence',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"publish_storyops_completed_work_evidence"|publish_storyops_completed_work_evidence)\s*\(/iu,
  },
  {
    name: 'public.create_storyops_recurring_due_work',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"create_storyops_recurring_due_work"|create_storyops_recurring_due_work)\s*\(/iu,
  },
  {
    name: 'public.attach_storyops_recurring_due_estimate',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"attach_storyops_recurring_due_estimate"|attach_storyops_recurring_due_estimate)\s*\(/iu,
  },
  {
    name: 'public.get_storyops_recurring_due_work',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"get_storyops_recurring_due_work"|get_storyops_recurring_due_work)\s*\(/iu,
  },
  {
    name: 'public.prepare_storyops_material_sds_registration',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"prepare_storyops_material_sds_registration"|prepare_storyops_material_sds_registration)\s*\(/iu,
  },
  {
    name: 'public.finalize_storyops_material_sds_registration',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"finalize_storyops_material_sds_registration"|finalize_storyops_material_sds_registration)\s*\(/iu,
  },
  {
    name: 'public.get_storyops_material_sds_registry',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"get_storyops_material_sds_registry"|get_storyops_material_sds_registry)\s*\(/iu,
  },
  {
    name: 'public.load_storyops_sds_upload_for_attestation',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"load_storyops_sds_upload_for_attestation"|load_storyops_sds_upload_for_attestation)\s*\(/iu,
  },
  {
    name: 'public.attest_storyops_sds_upload',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"attest_storyops_sds_upload"|attest_storyops_sds_upload)\s*\(/iu,
  },
  {
    name: 'public.get_storyops_provider_launch_state',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"get_storyops_provider_launch_state"|get_storyops_provider_launch_state)\s*\(/iu,
  },
  {
    name: 'public.reserve_storyops_trusted_pilot_verification',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"reserve_storyops_trusted_pilot_verification"|reserve_storyops_trusted_pilot_verification)\s*\(/iu,
  },
  {
    name: 'public.complete_storyops_restore_verification',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"complete_storyops_restore_verification"|complete_storyops_restore_verification)\s*\(/iu,
  },
  {
    name: 'public.record_storyops_trusted_pilot_proof',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"record_storyops_trusted_pilot_proof"|record_storyops_trusted_pilot_proof)\s*\(/iu,
  },
  {
    name: 'public.consume_storyops_dispatch_clearance',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"consume_storyops_dispatch_clearance"|consume_storyops_dispatch_clearance)\s*\(/iu,
  },
  {
    name: 'public.record_storyops_dispatch_clearance',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"record_storyops_dispatch_clearance"|record_storyops_dispatch_clearance)\s*\(/iu,
  },
  {
    name: 'public.link_storyops_identity',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"link_storyops_identity"|link_storyops_identity)\s*\(/iu,
  },
  {
    name: 'public.revoke_storyops_identity',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"revoke_storyops_identity"|revoke_storyops_identity)\s*\(/iu,
  },
  {
    name: 'public.create_storyops_customer_property',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"create_storyops_customer_property"|create_storyops_customer_property)\s*\(/iu,
  },
  {
    name: 'public.confirm_storyops_property_geocode_candidate',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"confirm_storyops_property_geocode_candidate"|confirm_storyops_property_geocode_candidate)\s*\(/iu,
  },
  {
    name: 'public.report_storyops_incident_and_pause',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"report_storyops_incident_and_pause"|report_storyops_incident_and_pause)\s*\(/iu,
  },
  {
    name: 'public.authorize_storyops_identity_invite',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"authorize_storyops_identity_invite"|authorize_storyops_identity_invite)\s*\(/iu,
  },
  {
    name: 'private.storyops_setup_receipts',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"private"|private)\s*\.\s*(?:"storyops_setup_receipts"|storyops_setup_receipts)(?![a-z0-9_])/iu,
  },
  {
    name: 'private.storyops_setup_receipt_quarantines',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"private"|private)\s*\.\s*(?:"storyops_setup_receipt_quarantines"|storyops_setup_receipt_quarantines)(?![a-z0-9_])/iu,
  },
  {
    name: 'setup receipt append-only authority',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"storyops_setup_receipts_append_only"|storyops_setup_receipts_append_only)(?![a-z0-9_])/iu,
  },
  {
    name: 'setup receipt quarantine append-only authority',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"storyops_setup_receipt_quarantines_append_only"|storyops_setup_receipt_quarantines_append_only)(?![a-z0-9_])/iu,
  },
  {
    name: 'setup completion receipt authority',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"complete_storyops_setup"|complete_storyops_setup)\s*\(/iu,
  },
  {
    name: 'dispatch origin UNLOGGED ephemera',
    pattern:
      /\bcreate\s+unlogged\s+table\s+(?:"private"|private)\s*\.\s*(?:"dispatch_current_origin_ephemera"|dispatch_current_origin_ephemera)(?![a-z0-9_])/iu,
  },
  {
    name: 'dispatch origin UNLOGGED verifiers',
    pattern:
      /\bcreate\s+unlogged\s+table\s+(?:"private"|private)\s*\.\s*(?:"dispatch_current_origin_verifiers"|dispatch_current_origin_verifiers)(?![a-z0-9_])/iu,
  },
  {
    name: 'dispatch origin purge worker health',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"private"|private)\s*\.\s*(?:"dispatch_origin_purge_worker_health"|dispatch_origin_purge_worker_health)(?![a-z0-9_])/iu,
  },
  {
    name: 'dispatch origin scheduler retention health',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"private"|private)\s*\.\s*(?:"storyops_dispatch_origin_retention_healthy"|storyops_dispatch_origin_retention_healthy)\s*\(/iu,
  },
  {
    name: 'private.storyops_field_media_canary_crews',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"private"|private)\s*\.\s*(?:"storyops_field_media_canary_crews"|storyops_field_media_canary_crews)(?![a-z0-9_])/iu,
  },
  {
    name: 'private.storyops_field_media_canary_registry_quarantine',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"private"|private)\s*\.\s*(?:"storyops_field_media_canary_registry_quarantine"|storyops_field_media_canary_registry_quarantine)(?![a-z0-9_])/iu,
  },
  {
    name: 'private.storyops_field_media_canary_crew_capabilities',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"private"|private)\s*\.\s*(?:"storyops_field_media_canary_crew_capabilities"|storyops_field_media_canary_crew_capabilities)(?![a-z0-9_])/iu,
  },
  {
    name: 'field-media retired job guard',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"jobs_retired_field_media_canary_guard"|jobs_retired_field_media_canary_guard)(?![a-z0-9_])/iu,
  },
  {
    name: 'field-media retired visit guard',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"visits_retired_field_media_canary_guard"|visits_retired_field_media_canary_guard)(?![a-z0-9_])/iu,
  },
  {
    name: 'field-media retired dispatch guard',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"dispatch_retired_field_media_canary_guard"|dispatch_retired_field_media_canary_guard)(?![a-z0-9_])/iu,
  },
  {
    name: 'field-media canary runtime capture',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"trusted_pilot_field_media_registry_capture"|trusted_pilot_field_media_registry_capture)(?![a-z0-9_])/iu,
  },
  {
    name: 'field-media canary launch quarantine gate',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"storyops_00_canary_quarantine_launch_gate"|storyops_00_canary_quarantine_launch_gate)(?![a-z0-9_])/iu,
  },
  {
    name: 'field-media canary crew activation guard',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"crews_controlled_rehearsal_inactive"|crews_controlled_rehearsal_inactive)(?![a-z0-9_])/iu,
  },
  {
    name: 'field-media canary completion isolation',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?trigger\s+(?:"trusted_pilot_field_media_completion_isolation"|trusted_pilot_field_media_completion_isolation)(?![a-z0-9_])/iu,
  },
  {
    name: 'identity unresolved email authority',
    pattern:
      /\bcreate\s+unique\s+index\s+(?:"identity_invitation_attempts_one_unresolved_email_idx"|identity_invitation_attempts_one_unresolved_email_idx)(?![a-z0-9_])/iu,
  },
  {
    name: 'identity attempt state authority',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"load_storyops_identity_invitation_attempt_state"|load_storyops_identity_invitation_attempt_state)\s*\(/iu,
  },
  {
    name: 'identity invitation provider claim authority',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"private"|private)\s*\.\s*(?:"claim_storyops_identity_invitation_attempt"|claim_storyops_identity_invitation_attempt)\s*\(/iu,
  },
  {
    name: 'identity invitation attempts forced RLS',
    pattern:
      /\balter\s+table(?:\s+only)?\s+(?:"public"|public)\s*\.\s*(?:"identity_invitation_attempts"|identity_invitation_attempts)\s+force\s+row\s+level\s+security\b/iu,
  },
]);

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseCliJson(output, label) {
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} returned an invalid JSON object.`);
  }
  return parsed;
}

function estimatedRowCount(value, tableName) {
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(normalized)) {
    throw new Error(`Table statistics returned an invalid estimate for "${tableName}".`);
  }
  return normalized < 0 ? null : normalized;
}

export function storyOpsSourceEvidence({
  migrationOutput,
  tableStatsOutput,
  observedAt = new Date().toISOString(),
}) {
  const migrationResult = parseCliJson(migrationOutput, 'Supabase migration list');
  if (!Array.isArray(migrationResult.migrations)) {
    throw new Error('Supabase migration list did not include a migrations array.');
  }
  const appliedVersions = migrationResult.migrations
    .map((migration) => migration?.remote)
    .filter((version) => typeof version === 'string' && /^\d{14}$/u.test(version))
    .sort();
  if (new Set(appliedVersions).size !== appliedVersions.length) {
    throw new Error('Supabase migration list contains duplicate applied versions.');
  }
  const missingMigrations = REQUIRED_STORYOPS_MIGRATIONS.filter(
    (version) => !appliedVersions.includes(version),
  );
  const unexpectedMigrations = appliedVersions.filter(
    (version) => !REQUIRED_STORYOPS_MIGRATIONS.includes(version),
  );
  if (missingMigrations.length > 0 || unexpectedMigrations.length > 0) {
    const details = [
      missingMigrations.length > 0 ? `missing ${missingMigrations.join(', ')}` : null,
      unexpectedMigrations.length > 0 ? `unexpected ${unexpectedMigrations.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    throw new Error(
      `Refusing backup: applied StoryOps migration set does not match this release (${details}).`,
    );
  }

  const statsResult = parseCliJson(tableStatsOutput, 'Supabase table statistics');
  if (!Array.isArray(statsResult.rows)) {
    throw new Error('Supabase table statistics did not include a rows array.');
  }
  const tableCounts = new Map();
  const requiredTableNames = new Set(STORYOPS_SCHEMA_SENTINELS);
  for (const row of statsResult.rows) {
    if (!row || typeof row.name !== 'string' || !requiredTableNames.has(row.name)) continue;
    if (tableCounts.has(row.name)) {
      throw new Error(`Supabase table statistics repeat "${row.name}".`);
    }
    tableCounts.set(row.name, estimatedRowCount(row.estimated_row_count, row.name));
  }
  const missingTables = STORYOPS_SCHEMA_SENTINELS.filter((name) => !tableCounts.has(name));
  if (missingTables.length > 0) {
    throw new Error(
      `Refusing backup: StoryOps source schema is missing sentinel table(s): ${missingTables.join(', ')}.`,
    );
  }

  return {
    requiredMigration: REQUIRED_STORYOPS_MIGRATION,
    requiredMigrationCount: REQUIRED_STORYOPS_MIGRATIONS.length,
    requiredMigrationSetFingerprint: {
      algorithm: 'sha256',
      value: sha256Text(REQUIRED_STORYOPS_MIGRATIONS.join('\n')),
    },
    appliedMigrationCount: appliedVersions.length,
    latestAppliedMigration: appliedVersions.at(-1),
    migrationSetFingerprint: {
      algorithm: 'sha256',
      value: sha256Text(appliedVersions.join('\n')),
    },
    estimatedTableCounts: {
      method: 'supabase-inspect-db-table-stats',
      observedAt,
      transactionallyConsistentWithDump: false,
      unavailableEstimateValue: null,
      tables: Object.fromEntries(
        [...tableCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
  };
}

export function validateStoryOpsSchemaDump(schemaSql) {
  if (typeof schemaSql !== 'string' || schemaSql.trim().length === 0) {
    throw new Error('StoryOps schema dump is empty.');
  }
  const missing = STORYOPS_SCHEMA_PATTERNS.filter(({ pattern }) => !pattern.test(schemaSql)).map(
    ({ name }) => name,
  );
  if (missing.length > 0) {
    throw new Error(
      `Refusing backup: schema dump is missing StoryOps sentinel(s): ${missing.join(', ')}.`,
    );
  }
  return STORYOPS_SCHEMA_PATTERNS.map(({ name }) => name);
}

function normalizedFileSize(value, label) {
  if (value === null || value === undefined) return null;
  const normalized =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} has an invalid file-size limit.`);
  }
  return normalized;
}

function normalizedMimeTypes(value, label) {
  if (value === null || value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.some(
      (mimeType) => typeof mimeType !== 'string' || mimeType.trim() !== mimeType || !mimeType,
    )
  ) {
    throw new Error(`${label} has invalid allowed MIME types.`);
  }
  const normalized = [...new Set(value)].sort();
  if (normalized.length !== value.length) {
    throw new Error(`${label} repeats an allowed MIME type.`);
  }
  return normalized;
}

function manifestBucketPolicy(bucket) {
  if (
    !bucket ||
    typeof bucket.id !== 'string' ||
    !bucket.id ||
    bucket.id.trim() !== bucket.id ||
    typeof bucket.public !== 'boolean'
  ) {
    throw new Error('Backup Storage manifest contains an invalid bucket record.');
  }
  return {
    id: bucket.id,
    public: bucket.public,
    fileSizeLimit: normalizedFileSize(bucket.fileSizeLimit, `Backup Storage bucket "${bucket.id}"`),
    allowedMimeTypes: normalizedMimeTypes(
      bucket.allowedMimeTypes,
      `Backup Storage bucket "${bucket.id}"`,
    ),
  };
}

function existingBucketPolicy(bucket) {
  if (!bucket || typeof bucket.id !== 'string' || !bucket.id) {
    throw new Error('Target Storage returned an invalid bucket record.');
  }
  if (typeof bucket.public !== 'boolean') {
    throw new Error(`Target Storage bucket "${bucket.id}" has an invalid public policy.`);
  }
  return {
    id: bucket.id,
    public: bucket.public,
    fileSizeLimit: normalizedFileSize(
      bucket.file_size_limit ?? bucket.fileSizeLimit,
      `Target Storage bucket "${bucket.id}"`,
    ),
    allowedMimeTypes: normalizedMimeTypes(
      bucket.allowed_mime_types ?? bucket.allowedMimeTypes,
      `Target Storage bucket "${bucket.id}"`,
    ),
  };
}

export function validateStorageBucketManifest(buckets) {
  if (!Array.isArray(buckets)) {
    throw new Error('Backup Storage manifest has no bucket list.');
  }
  const policies = buckets.map(manifestBucketPolicy);
  const ids = policies.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Backup Storage manifest repeats a bucket id.');
  }
  return policies;
}

export function storageBucketPolicyDrift({ manifestBuckets, existingBuckets, targetHost }) {
  if (typeof targetHost !== 'string' || !targetHost) {
    throw new Error('Storage policy comparison requires the exact target host.');
  }
  const expectedPolicies = validateStorageBucketManifest(manifestBuckets);
  if (!Array.isArray(existingBuckets)) {
    throw new Error('Target Storage bucket list is invalid.');
  }
  const actualPolicies = existingBuckets.map(existingBucketPolicy);
  const actualById = new Map();
  for (const policy of actualPolicies) {
    if (actualById.has(policy.id)) {
      throw new Error(`Target Storage repeats bucket "${policy.id}".`);
    }
    actualById.set(policy.id, policy);
  }

  const drift = [];
  for (const expected of expectedPolicies) {
    const actual = actualById.get(expected.id);
    if (!actual) continue;
    if (
      actual.public !== expected.public ||
      actual.fileSizeLimit !== expected.fileSizeLimit ||
      JSON.stringify(actual.allowedMimeTypes) !== JSON.stringify(expected.allowedMimeTypes)
    ) {
      drift.push({ bucketId: expected.id, expected, actual });
    }
  }
  drift.sort((left, right) => left.bucketId.localeCompare(right.bucketId));
  return {
    drift,
    confirmationSha256:
      drift.length === 0
        ? null
        : sha256Text(
            JSON.stringify({
              targetHost,
              drift,
            }),
          ),
  };
}

export function assertStoragePolicyDriftConfirmation({
  comparison,
  allowPolicyDrift,
  policyDriftConfirmation,
}) {
  if (!comparison || !Array.isArray(comparison.drift)) {
    throw new Error('Storage bucket policy comparison result is invalid.');
  }
  if (comparison.drift.length === 0) return [];
  const bucketIds = comparison.drift.map(({ bucketId }) => bucketId);
  if (
    !allowPolicyDrift ||
    !policyDriftConfirmation ||
    policyDriftConfirmation !== comparison.confirmationSha256
  ) {
    throw new Error(
      `Storage bucket policy drift detected for ${bucketIds.join(', ')}. No Storage changes were made. After review, preserve the existing policies only with --allow-storage-policy-drift --confirm-storage-policy-drift ${comparison.confirmationSha256}.`,
    );
  }
  return bucketIds;
}
