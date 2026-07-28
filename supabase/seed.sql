-- Local demo data only. Passwords are intentionally local-development credentials.
-- Never apply this seed to a production project.

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000101',
    'authenticated',
    'authenticated',
    'owner@storyops.local',
    extensions.crypt('StoryOpsDemo1!', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Alex Owner"}',
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000102',
    'authenticated',
    'authenticated',
    'dispatcher@storyops.local',
    extensions.crypt('StoryOpsDemo1!', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Dana Dispatcher"}',
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000103',
    'authenticated',
    'authenticated',
    'technician@storyops.local',
    extensions.crypt('StoryOpsDemo1!', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Taylor Technician"}',
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000104',
    'authenticated',
    'authenticated',
    'customer@storyops.local',
    extensions.crypt('StoryOpsDemo1!', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Casey Customer"}',
    now(),
    now(),
    '',
    '',
    '',
    ''
  )
on conflict (id) do nothing;

insert into auth.identities (
  id,
  provider_id,
  user_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
select
  u.id,
  u.email,
  u.id,
  jsonb_build_object(
    'sub', u.id::text,
    'email', u.email,
    'email_verified', true,
    'phone_verified', false
  ),
  'email',
  now(),
  now(),
  now()
from auth.users u
where u.id in (
  '10000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000102',
  '10000000-0000-4000-8000-000000000103',
  '10000000-0000-4000-8000-000000000104'
)
on conflict (provider, provider_id) do nothing;

insert into public.companies (
  id,
  name,
  timezone,
  settings
)
values (
  '10000000-0000-4000-8000-000000000001',
  'StoryOps Exterior Services',
  'America/Chicago',
  '{
    "serviceArea": "Dallas–Fort Worth",
    "weatherPolicy": {
      "minimumTemperatureF": "40",
      "maximumTemperatureF": "105",
      "maximumWindSpeedMph": "20",
      "maximumPrecipitationProbability": "0.50",
      "prohibitedLightningRisks": ["elevated", "severe", "unknown"]
    },
    "setupWizardCompleted": true
  }'
);

insert into public.company_memberships (id, company_id, user_id, role)
values
  (
    '10000000-0000-4000-8000-000000000111',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    'owner'
  ),
  (
    '10000000-0000-4000-8000-000000000112',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000102',
    'dispatcher'
  ),
  (
    '10000000-0000-4000-8000-000000000113',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000103',
    'technician'
  ),
  (
    '10000000-0000-4000-8000-000000000114',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    'customer'
  );

-- Local sandbox terms exercise the legal-review gate. They are not production
-- legal advice and never leave the local seed environment.
insert into public.service_terms (
  id,
  company_id,
  version_label,
  status,
  terms_text,
  review_reference,
  reviewed_by,
  reviewed_at,
  effective_from
)
values (
  '10000000-0000-4000-8000-000000000152',
  '10000000-0000-4000-8000-000000000001',
  'terms-v1',
  'approved',
  'Local sandbox service terms: scope is limited to the accepted quote; the customer provides safe access and working water; StoryOps stops work when conditions are unsafe. Replace with qualified, jurisdiction-specific review evidence before any production launch.',
  'LOCAL-SANDBOX-ONLY-NOT-LEGAL-ADVICE',
  '10000000-0000-4000-8000-000000000101',
  now(),
  now() - interval '1 day'
);

-- Proposed local policy only. It deliberately remains a draft until the
-- required legal/tax/privacy review is actually completed.
insert into public.retention_policies (
  id,
  company_id,
  version_label,
  status,
  effective_from,
  class_rules,
  legal_review_status
)
values (
  '10000000-0000-4000-8000-000000000151',
  '10000000-0000-4000-8000-000000000001',
  'proposed-dfw-v1',
  'draft',
  now() - interval '1 day',
  '{
    "operational":{"days":2555,"review":"required"},
    "communication":{"days":730,"review":"required"},
    "ai_trace":{"days":90,"review":"required"},
    "audit":{"days":2555,"review":"required"},
    "safety":{"days":1460,"review":"required"}
  }',
  'required'
);

insert into public.customers (
  id,
  company_id,
  kind,
  display_name,
  given_name,
  family_name,
  email,
  phone,
  billing_address,
  lifecycle,
  tags
)
values (
  '10000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000001',
  'individual',
  'Casey Morgan',
  'Casey',
  'Morgan',
  'customer@storyops.local',
  '+12145550172',
  '{
    "line1":"4100 Cedar Springs Rd",
    "city":"Dallas",
    "region":"TX",
    "postalCode":"75219",
    "country":"US"
  }',
  'active',
  array['demo', 'repeat-candidate']
);

insert into public.customer_portal_users (
  id,
  company_id,
  user_id,
  customer_id
)
values (
  '10000000-0000-4000-8000-000000000202',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000104',
  '10000000-0000-4000-8000-000000000201'
);

insert into public.properties (
  id,
  company_id,
  customer_id,
  name,
  property_type,
  service_address,
  access_instructions,
  water_source_notes,
  known_hazards,
  stories,
  latitude,
  longitude,
  geocode_confidence,
  geocoded_at
)
values (
  '10000000-0000-4000-8000-000000000211',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000201',
  'Morgan Residence',
  'single_family',
  '{
    "line1":"4100 Cedar Springs Rd",
    "city":"Dallas",
    "region":"TX",
    "postalCode":"75219",
    "country":"US"
  }',
  'Text on arrival; side gate is unlocked.',
  'Exterior spigot on north wall.',
  array['decorative low-voltage lighting along driveway'],
  2,
  32.8119000,
  -96.8098000,
  0.9900,
  now()
);

insert into public.leads (
  id,
  company_id,
  source,
  status,
  display_name,
  email,
  phone,
  requested_services,
  preferred_contact_channel,
  customer_id,
  property_id
)
values
  (
    '10000000-0000-4000-8000-000000000221',
    '10000000-0000-4000-8000-000000000001',
    'web',
    'qualifying',
    'Jordan Lee',
    'jordan@example.test',
    '+12145550199',
    array['soft-wash-house', 'gutter-cleaning'],
    'sms',
    null,
    null
  ),
  (
    '10000000-0000-4000-8000-000000000222',
    '10000000-0000-4000-8000-000000000001',
    'referral',
    'converted',
    'Casey Morgan',
    'customer@storyops.local',
    '+12145550172',
    array['pressure-wash-flatwork', 'gutter-cleaning'],
    'email',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211'
  );

insert into public.consent_records (
  id,
  company_id,
  customer_id,
  channel,
  purpose,
  status,
  captured_at,
  capture_method,
  disclosure_version,
  proof
)
values
  (
    '10000000-0000-4000-8000-000000000231',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    'sms',
    'transactional',
    'granted',
    now() - interval '7 days',
    'web_form',
    'consent-v1',
    'Local demo seed: checked transactional SMS consent box.'
  ),
  (
    '10000000-0000-4000-8000-000000000232',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    'email',
    'marketing',
    'granted',
    now() - interval '7 days',
    'web_form',
    'consent-v1',
    'Local demo seed: checked marketing email consent box.'
  ),
  (
    '10000000-0000-4000-8000-000000000233',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    'sms',
    'marketing',
    'granted',
    now() - interval '7 days',
    'web_form',
    'consent-v1',
    'Local demo seed: checked marketing SMS consent box.'
  );

insert into public.checklist_templates (
  id,
  company_id,
  name,
  service_code,
  version_label,
  active
)
values (
  '10000000-0000-4000-8000-000000000301',
  '10000000-0000-4000-8000-000000000001',
  'Exterior Wash + Gutter Field Checklist',
  null,
  '1.0.0',
  true
);

insert into public.checklist_template_items (
  id,
  company_id,
  template_id,
  item_key,
  label,
  item_kind,
  required,
  safety_critical,
  sort_order
)
values
  (
    '10000000-0000-4000-8000-000000000311',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000301',
    'site-hazard-review',
    'Review property hazards and stop-work conditions',
    'boolean',
    true,
    true,
    10
  ),
  (
    '10000000-0000-4000-8000-000000000312',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000301',
    'before-photos',
    'Capture before photos',
    'photo',
    true,
    false,
    20
  ),
  (
    '10000000-0000-4000-8000-000000000313',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000301',
    'protect-property',
    'Confirm plants, outlets, windows, and fixtures are protected',
    'boolean',
    true,
    true,
    30
  ),
  (
    '10000000-0000-4000-8000-000000000314',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000301',
    'downspout-flow',
    'Verify downspout flow',
    'boolean',
    true,
    false,
    40
  ),
  (
    '10000000-0000-4000-8000-000000000315',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000301',
    'after-photos',
    'Capture after photos',
    'photo',
    true,
    false,
    50
  ),
  (
    '10000000-0000-4000-8000-000000000316',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000301',
    'completion-signature',
    'Capture completion signature',
    'signature',
    true,
    false,
    60
  );

insert into public.service_catalog (
  id,
  company_id,
  code,
  name,
  description,
  category,
  active,
  taxable,
  required_skills,
  required_equipment_types,
  required_measurement_kinds,
  safety_sop_reference,
  default_checklist_template_id
)
values
  (
    '10000000-0000-4000-8000-000000000321',
    '10000000-0000-4000-8000-000000000001',
    'pressure-wash-flatwork',
    'Pressure Wash Flatwork',
    'Pressure washing for concrete and other approved hardscape.',
    'pressure_washing',
    true,
    true,
    array['pressure-washing'],
    array['pressure-washer', 'surface-cleaner'],
    array['area_sq_ft'],
    'SOP-PW-001',
    '10000000-0000-4000-8000-000000000301'
  ),
  (
    '10000000-0000-4000-8000-000000000322',
    '10000000-0000-4000-8000-000000000001',
    'soft-wash-house',
    'House Soft Wash',
    'Low-pressure exterior cleaning for approved siding surfaces.',
    'soft_washing',
    true,
    true,
    array['soft-washing'],
    array['soft-wash-system'],
    array['area_sq_ft', 'stories'],
    'SOP-SW-001',
    '10000000-0000-4000-8000-000000000301'
  ),
  (
    '10000000-0000-4000-8000-000000000323',
    '10000000-0000-4000-8000-000000000001',
    'gutter-cleaning',
    'Gutter Cleaning',
    'Debris removal and bagging for accessible gutter runs.',
    'gutter_cleaning',
    true,
    true,
    array['ladder-safety', 'gutter-cleaning'],
    array['ladder'],
    array['length_linear_ft', 'stories'],
    'SOP-GC-001',
    '10000000-0000-4000-8000-000000000301'
  ),
  (
    '10000000-0000-4000-8000-000000000324',
    '10000000-0000-4000-8000-000000000001',
    'downspout-flush',
    'Downspout Flush',
    'Water-flow verification and flushing where access is safe.',
    'downspout_cleaning',
    true,
    true,
    array['ladder-safety', 'gutter-cleaning'],
    array['ladder'],
    array['count'],
    'SOP-GC-001',
    '10000000-0000-4000-8000-000000000301'
  );

insert into public.price_books (
  id,
  company_id,
  name,
  version_label,
  status,
  effective_from,
  currency,
  company_minimum,
  default_tax_rate_pct,
  margin_floor_pct,
  automatic_discount_limit_pct,
  deposit_kind,
  deposit_value
)
values (
  '10000000-0000-4000-8000-000000000401',
  '10000000-0000-4000-8000-000000000001',
  'DFW Residential Launch',
  '2026.1',
  'draft',
  '2026-01-01T00:00:00-06:00',
  'USD',
  149.00,
  8.2500,
  35.0000,
  10.0000,
  'percent',
  25.0000
);

insert into public.price_book_service_rules (
  id,
  company_id,
  price_book_id,
  service_catalog_id,
  service_code,
  pricing_unit,
  base_price,
  unit_price,
  included_quantity,
  service_minimum,
  estimated_base_cost,
  estimated_unit_cost,
  duration_base_minutes,
  duration_minutes_per_unit,
  taxable,
  allowed_attribute_values
)
values
  (
    '10000000-0000-4000-8000-000000000411',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000401',
    '10000000-0000-4000-8000-000000000321',
    'pressure-wash-flatwork',
    'sq_ft',
    0,
    0.180000,
    0,
    149,
    25,
    0.040000,
    30,
    0.0400,
    true,
    '{"surface":["concrete","pavers"],"soil":["light","medium","heavy"],"access":["standard","difficult"],"risk":["standard","elevated"]}'
  ),
  (
    '10000000-0000-4000-8000-000000000412',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000401',
    '10000000-0000-4000-8000-000000000322',
    'soft-wash-house',
    'sq_ft',
    0,
    0.250000,
    0,
    249,
    55,
    0.060000,
    60,
    0.0450,
    true,
    '{"stories":["one","two","three"],"surface":["vinyl","brick","stucco"],"soil":["light","medium","heavy"],"access":["standard","difficult"],"risk":["standard","elevated"]}'
  ),
  (
    '10000000-0000-4000-8000-000000000413',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000401',
    '10000000-0000-4000-8000-000000000323',
    'gutter-cleaning',
    'linear_ft',
    0,
    0.950000,
    0,
    179,
    35,
    0.180000,
    45,
    0.2500,
    true,
    '{"stories":["one","two","three"],"soil":["light","medium","heavy"],"access":["standard","difficult"],"risk":["standard","elevated"]}'
  );

insert into public.price_book_attribute_multipliers (
  company_id,
  service_rule_id,
  attribute,
  attribute_value,
  multiplier
)
values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000411', 'surface', 'concrete', 1.0000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000411', 'surface', 'pavers', 1.2000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000411', 'soil', 'light', 1.0000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000411', 'soil', 'medium', 1.1500),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000411', 'soil', 'heavy', 1.3500),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000411', 'access', 'standard', 1.0000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000411', 'access', 'difficult', 1.2500),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000411', 'risk', 'standard', 1.0000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000411', 'risk', 'elevated', 1.3000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000412', 'stories', 'one', 1.0000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000412', 'stories', 'two', 1.3500),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000412', 'stories', 'three', 1.7000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000412', 'surface', 'vinyl', 1.0000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000412', 'surface', 'brick', 1.1500),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000412', 'surface', 'stucco', 1.3000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000412', 'soil', 'light', 1.0000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000412', 'soil', 'medium', 1.1500),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000412', 'soil', 'heavy', 1.3500),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000412', 'access', 'standard', 1.0000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000412', 'access', 'difficult', 1.2500),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000412', 'risk', 'standard', 1.0000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000412', 'risk', 'elevated', 1.3000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000413', 'stories', 'one', 1.0000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000413', 'stories', 'two', 1.3500),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000413', 'stories', 'three', 1.7000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000413', 'soil', 'light', 1.0000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000413', 'soil', 'medium', 1.1500),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000413', 'soil', 'heavy', 1.3500),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000413', 'access', 'standard', 1.0000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000413', 'access', 'difficult', 1.2500),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000413', 'risk', 'standard', 1.0000),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000413', 'risk', 'elevated', 1.3000);

insert into public.price_book_add_ons (
  id,
  company_id,
  service_rule_id,
  code,
  name,
  pricing_unit,
  unit_price,
  estimated_unit_cost,
  duration_minutes_per_unit,
  taxable
)
values
  (
    '10000000-0000-4000-8000-000000000421',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000411',
    'spot-treatment',
    'Targeted spot treatment',
    'each',
    15,
    2,
    5,
    true
  ),
  (
    '10000000-0000-4000-8000-000000000422',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000413',
    'downspout-flush',
    'Downspout flow test and flush',
    'each',
    18,
    4,
    10,
    true
  );

insert into public.price_book_travel_zones (
  id,
  company_id,
  price_book_id,
  zone_code,
  name,
  fee,
  taxable,
  maximum_one_way_miles,
  postal_codes
)
values
  (
    '10000000-0000-4000-8000-000000000431',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000401',
    'DFW-CORE',
    'DFW core service area',
    0,
    false,
    20,
    array['75001', '75201', '75204', '75205', '75219']
  ),
  (
    '10000000-0000-4000-8000-000000000432',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000401',
    'DFW-OUTER',
    'DFW outer service area',
    35,
    false,
    40,
    '{}'
  );

update public.price_books
set
  status = 'active',
  published_by = '10000000-0000-4000-8000-000000000101',
  published_at = now() - interval '7 days'
where id = '10000000-0000-4000-8000-000000000401';

insert into public.property_measurements (
  id,
  company_id,
  property_id,
  kind,
  label,
  value,
  unit,
  source,
  measured_at,
  measured_by,
  source_asset_ids,
  confidence,
  verified_by_human,
  service_codes,
  add_on_codes
)
values
  (
    '10000000-0000-4000-8000-000000000441',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000211',
    'area_sq_ft',
    'Driveway',
    850,
    'sq_ft',
    'field_measured',
    now() - interval '5 days',
    '10000000-0000-4000-8000-000000000103',
    '{}',
    1,
    true,
    array['pressure-wash-flatwork'],
    '{}'
  ),
  (
    '10000000-0000-4000-8000-000000000442',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000211',
    'length_linear_ft',
    'Gutter run',
    180,
    'linear_ft',
    'field_measured',
    now() - interval '5 days',
    '10000000-0000-4000-8000-000000000103',
    '{}',
    1,
    true,
    array['gutter-cleaning'],
    '{}'
  ),
  (
    '10000000-0000-4000-8000-000000000443',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000211',
    'count',
    'Downspouts',
    4,
    'each',
    'field_measured',
    now() - interval '5 days',
    '10000000-0000-4000-8000-000000000103',
    '{}',
    1,
    true,
    '{}',
    array['downspout-flush']
  ),
  (
    '10000000-0000-4000-8000-000000000444',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000211',
    'area_sq_ft',
    'House siding area',
    1600,
    'sq_ft',
    'field_measured',
    now() - interval '5 days',
    '10000000-0000-4000-8000-000000000103',
    '{}',
    1,
    true,
    array['soft-wash-house'],
    '{}'
  );

insert into public.estimates (
  id,
  company_id,
  estimate_number,
  customer_id,
  property_id,
  price_book_id,
  price_book_version,
  status,
  service_subtotal,
  minimum_adjustment,
  travel_fee,
  manual_adjustment,
  discount,
  taxable_subtotal,
  tax,
  total,
  deposit_required,
  estimated_cost,
  estimated_margin_pct,
  duration_minutes,
  calculation_version,
  calculation_input,
  calculation_issues,
  calculated_at
)
values (
  '10000000-0000-4000-8000-000000000501',
  '10000000-0000-4000-8000-000000000001',
  'EST-2026-0001',
  '10000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000211',
  '10000000-0000-4000-8000-000000000401',
  '2026.1',
  'approved',
  513.43,
  0,
  0,
  0,
  25.67,
  487.76,
  40.24,
  528.00,
  132.00,
  188.51,
  61.3500,
  254,
  'storyops-pricing-v1.0.0',
  '{
    "services":[
      {
        "serviceCode":"pressure-wash-flatwork",
        "quantity":"850",
        "attributes":{"surface":"concrete","soil":"medium","access":"standard","risk":"standard"}
      },
      {
        "serviceCode":"gutter-cleaning",
        "quantity":"180",
        "attributes":{"stories":"two","soil":"medium","access":"standard","risk":"standard"},
        "addOns":[{"code":"downspout-flush","quantity":"4"}]
      }
    ],
    "travelZoneCode":"DFW-CORE",
    "discount":{"kind":"percent","value":"5","reason":"Approved launch offer"}
  }',
  '[]',
  now() - interval '4 days'
);

insert into public.estimate_lines (
  id,
  company_id,
  estimate_id,
  line_kind,
  service_code,
  add_on_code,
  description,
  quantity,
  unit,
  unit_price,
  multiplier,
  subtotal,
  taxable,
  estimated_cost,
  source_measurement_ids,
  sort_order
)
values
  (
    '10000000-0000-4000-8000-000000000511',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000501',
    'service',
    'pressure-wash-flatwork',
    null,
    'Pressure Wash Flatwork',
    850,
    'sq_ft',
    0.18,
    1.15,
    175.95,
    true,
    67.85,
    array['10000000-0000-4000-8000-000000000441']::uuid[],
    10
  ),
  (
    '10000000-0000-4000-8000-000000000512',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000501',
    'service',
    'gutter-cleaning',
    null,
    'Gutter Cleaning',
    180,
    'linear_ft',
    0.95,
    1.5525,
    265.48,
    true,
    104.66,
    array['10000000-0000-4000-8000-000000000442']::uuid[],
    20
  ),
  (
    '10000000-0000-4000-8000-000000000513',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000501',
    'add_on',
    'gutter-cleaning',
    'downspout-flush',
    'Downspout flow test and flush',
    4,
    'each',
    18,
    1,
    72,
    true,
    16,
    array['10000000-0000-4000-8000-000000000443']::uuid[],
    30
  );

insert into public.quotes (
  id,
  company_id,
  quote_number,
  estimate_id,
  customer_id,
  property_id,
  status,
  valid_until,
  terms_version,
  terms_snapshot,
  total,
  deposit_required,
  sent_at,
  accepted_at,
  accepted_by_name,
  accepted_by_user_id,
  acceptance_ip_hash,
  acceptance_context_hash
)
values (
  '10000000-0000-4000-8000-000000000521',
  '10000000-0000-4000-8000-000000000001',
  'Q-2026-0001',
  '10000000-0000-4000-8000-000000000501',
  '10000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000211',
  'accepted',
  current_date + 14,
  'terms-v1',
  'Demo terms only. Production terms require legal review before launch.',
  528.00,
  132.00,
  now() - interval '3 days',
  now() - interval '2 days',
  'Casey Morgan',
  '10000000-0000-4000-8000-000000000104',
  encode(extensions.digest('127.0.0.1', 'sha256'), 'hex'),
  encode(extensions.digest('demo-quote-acceptance-context', 'sha256'), 'hex')
);

insert into public.crews (
  id,
  company_id,
  name,
  active,
  lead_technician_id,
  skill_codes,
  home_base_postal_code
)
values (
  '10000000-0000-4000-8000-000000000601',
  '10000000-0000-4000-8000-000000000001',
  'Owner Field Crew',
  true,
  '10000000-0000-4000-8000-000000000103',
  array['pressure-washing', 'soft-washing', 'ladder-safety', 'gutter-cleaning'],
  '75201'
);

insert into public.crew_members (
  id,
  company_id,
  crew_id,
  user_id,
  starts_on
)
values (
  '10000000-0000-4000-8000-000000000602',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000601',
  '10000000-0000-4000-8000-000000000103',
  current_date - 30
);

insert into public.equipment (
  id,
  company_id,
  asset_tag,
  name,
  equipment_type,
  status,
  assigned_crew_id,
  last_inspection_at,
  next_inspection_due
)
values
  (
    '10000000-0000-4000-8000-000000000611',
    '10000000-0000-4000-8000-000000000001',
    'PW-001',
    '4 GPM Pressure Washer',
    'pressure-washer',
    'assigned',
    '10000000-0000-4000-8000-000000000601',
    now() - interval '7 days',
    current_date + 23
  ),
  (
    '10000000-0000-4000-8000-000000000612',
    '10000000-0000-4000-8000-000000000001',
    'LAD-001',
    'Extension Ladder',
    'ladder',
    'assigned',
    '10000000-0000-4000-8000-000000000601',
    now() - interval '7 days',
    current_date + 23
  );

insert into public.materials (
  id,
  company_id,
  sku,
  name,
  unit,
  quantity_on_hand,
  reorder_point,
  sds_document_id,
  requires_sds,
  active
)
values
  (
    '10000000-0000-4000-8000-000000000613',
    '10000000-0000-4000-8000-000000000001',
    'BAG-DEBRIS-01',
    'Debris disposal bag',
    'each',
    40,
    10,
    null,
    false,
    true
  ),
  (
    '10000000-0000-4000-8000-000000000614',
    '10000000-0000-4000-8000-000000000001',
    'WATER-RINSE-01',
    'Fresh-water rinse',
    'gal',
    250,
    50,
    null,
    false,
    true
  );

insert into public.route_checks (
  id,
  company_id,
  provider,
  checked_at,
  route_feasible,
  drive_minutes,
  added_distance_miles,
  violations,
  request_payload,
  response_payload
)
values (
  '10000000-0000-4000-8000-000000000621',
  '10000000-0000-4000-8000-000000000001',
  'mock',
  now(),
  true,
  24,
  11.20,
  '{}',
  '{
    "mode":"sandbox",
    "jobs":1,
    "jobId":"10000000-0000-4000-8000-000000000631"
  }',
  '{"mode":"sandbox","routes":1,"unassigned":[]}'
);

insert into public.weather_checks (
  id,
  company_id,
  property_id,
  provider,
  forecast_issued_at,
  checked_at,
  period_starts_at,
  period_ends_at,
  temperature_f,
  precipitation_probability,
  wind_speed_mph,
  lightning_risk,
  condition_codes,
  policy_disposition,
  raw_forecast
)
values (
  '10000000-0000-4000-8000-000000000622',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000211',
  'mock',
  now(),
  now(),
  date_trunc('day', now() + interval '2 days') + interval '9 hours',
  date_trunc('day', now() + interval '2 days') + interval '14 hours',
  78,
  0.10,
  8,
  'none',
  array['clear'],
  'eligible',
  '{"mode":"sandbox","summary":"Clear, light wind"}'
);

insert into public.jobs (
  id,
  company_id,
  job_number,
  quote_id,
  customer_id,
  property_id,
  status,
  priority,
  service_codes,
  estimated_duration_minutes,
  estimated_revenue,
  estimated_cost,
  assigned_crew_id
)
values (
  '10000000-0000-4000-8000-000000000631',
  '10000000-0000-4000-8000-000000000001',
  'JOB-2026-0001',
  '10000000-0000-4000-8000-000000000521',
  '10000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000211',
  'scheduled',
  'routine',
  array['pressure-wash-flatwork', 'gutter-cleaning'],
  254,
  528.00,
  188.51,
  '10000000-0000-4000-8000-000000000601'
);

insert into public.visits (
  id,
  company_id,
  job_id,
  sequence,
  status,
  starts_at,
  ends_at,
  crew_id,
  route_check_id,
  weather_check_id,
  checklist_template_id
)
values (
  '10000000-0000-4000-8000-000000000641',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000631',
  1,
  'confirmed',
  date_trunc('day', now() + interval '2 days') + interval '9 hours',
  date_trunc('day', now() + interval '2 days') + interval '13 hours 30 minutes',
  '10000000-0000-4000-8000-000000000601',
  '10000000-0000-4000-8000-000000000621',
  '10000000-0000-4000-8000-000000000622',
  '10000000-0000-4000-8000-000000000301'
);

insert into public.dispatch_assignments (
  id,
  company_id,
  visit_id,
  crew_id,
  assigned_by,
  starts_at,
  ends_at,
  route_position,
  status
)
values (
  '10000000-0000-4000-8000-000000000642',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000641',
  '10000000-0000-4000-8000-000000000601',
  '10000000-0000-4000-8000-000000000102',
  date_trunc('day', now() + interval '2 days') + interval '9 hours',
  date_trunc('day', now() + interval '2 days') + interval '13 hours 30 minutes',
  1,
  'confirmed'
);

insert into public.visit_checklist_items (
  id,
  company_id,
  visit_id,
  template_item_id,
  status
)
select
  gen_random_uuid(),
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000641',
  item.id,
  'pending'
from public.checklist_template_items item
where item.template_id = '10000000-0000-4000-8000-000000000301';

insert into public.communication_threads (
  id,
  company_id,
  customer_id,
  subject,
  status,
  assigned_user_id,
  last_message_at
)
values (
  '10000000-0000-4000-8000-000000000701',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000201',
  'Quote and booking',
  'waiting',
  '10000000-0000-4000-8000-000000000102',
  now() - interval '1 day'
);

insert into public.communication_messages (
  id,
  company_id,
  thread_id,
  channel,
  direction,
  sender,
  recipients,
  body,
  provider_message_id,
  delivery_status,
  consent_record_id,
  sent_by_agent,
  sent_at,
  retain_until
)
values (
  '10000000-0000-4000-8000-000000000702',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000701',
  'sms',
  'outbound',
  '+12145550100',
  array['+12145550172'],
  'Your StoryOps demo visit is confirmed. Reply STOP to opt out.',
  'mock-sms-demo-001',
  'delivered',
  '10000000-0000-4000-8000-000000000231',
  'scheduling',
  now() - interval '1 day',
  now() + interval '3 years'
);

insert into public.approval_requests (
  id,
  company_id,
  reason,
  risk_level,
  status,
  requested_by_type,
  requested_by_id,
  requested_at,
  entity_type,
  entity_id,
  action_type,
  action_payload,
  summary,
  policy_version
)
values (
  '10000000-0000-4000-8000-000000000801',
  '10000000-0000-4000-8000-000000000001',
  'large_discount',
  'medium',
  'pending',
  'agent',
  'estimating',
  now() - interval '30 minutes',
  'estimate',
  '10000000-0000-4000-8000-000000000501',
  'apply_discount',
  '{"requestedPercent":"20","automaticLimitPercent":"10","reason":"Customer requested match"}',
  'A proposed 20% discount exceeds the 10% automatic limit.',
  'storyops-policy-v1.0.0'
);

insert into public.automation_runs (
  id,
  company_id,
  automation_key,
  trigger_type,
  trigger_reference,
  status,
  started_at,
  idempotency_key,
  attempt,
  input,
  approval_request_id
)
values (
  '10000000-0000-4000-8000-000000000811',
  '10000000-0000-4000-8000-000000000001',
  'estimate.follow-up',
  'event',
  'estimate:10000000-0000-4000-8000-000000000501',
  'waiting_approval',
  now() - interval '30 minutes',
  'estimate-follow-up:demo-001',
  1,
  '{"estimateId":"10000000-0000-4000-8000-000000000501"}',
  '10000000-0000-4000-8000-000000000801'
);

insert into public.ai_traces (
  id,
  company_id,
  trace_id,
  span_id,
  agent,
  operation,
  status,
  model,
  prompt_version,
  started_at,
  ended_at,
  input_redacted,
  output_redacted,
  guardrail_results,
  input_tokens,
  output_tokens,
  retention_class,
  retain_until
)
values (
  '10000000-0000-4000-8000-000000000821',
  '10000000-0000-4000-8000-000000000001',
  'demo-trace-001',
  'demo-span-001',
  'estimating',
  'evaluate-discount-policy',
  'approval_required',
  'sandbox',
  'estimating-v1',
  now() - interval '31 minutes',
  now() - interval '30 minutes',
  '{"estimateId":"10000000-0000-4000-8000-000000000501","pii":"[REDACTED]"}',
  '{"decision":"require_approval","reason":"large_discount"}',
  '[{"guardrail":"approval","passed":false,"detail":"Discount exceeds automatic limit"}]',
  0,
  0,
  'ai_trace',
  now() + interval '90 days'
);

insert into public.integration_connections (
  company_id,
  provider,
  mode,
  status,
  configuration,
  capabilities,
  last_checked_at
)
select
  '10000000-0000-4000-8000-000000000001',
  provider,
  'sandbox',
  'healthy',
  jsonb_build_object('mode', 'deterministic_mock'),
  capabilities,
  now()
from (
  values
    ('openai', array['structured-output', 'tracing']),
    ('twilio', array['sms', 'voice', 'webhook-validation']),
    ('email', array['transactional-email']),
    ('stripe', array['checkout', 'invoicing', 'webhooks']),
    ('google_calendar', array['availability', 'visit-sync']),
    ('maps', array['geocoding', 'distance']),
    ('nws', array['forecast']),
    ('vroom', array['route-optimization']),
    ('signed_storage_targets', array['server-signed-upload', 'server-signed-download']),
    ('quickbooks_export', array['csv-export'])
) as integrations(provider, capabilities);

-- Coherent local golden-path billing state. This is an explicitly labeled
-- local provider fixture: the succeeded deposit is backed by a processed,
-- redacted provider receipt so booking never infers payment from UI state.
insert into public.equipment (
  id,
  company_id,
  asset_tag,
  name,
  equipment_type,
  status,
  assigned_crew_id,
  last_inspection_at,
  next_inspection_due
)
values (
  '10000000-0000-4000-8000-000000000613',
  '10000000-0000-4000-8000-000000000001',
  'SC-001',
  '20-inch Surface Cleaner',
  'surface-cleaner',
  'assigned',
  '10000000-0000-4000-8000-000000000601',
  now() - interval '7 days',
  current_date + 23
);

insert into public.invoices (
  id,
  company_id,
  invoice_number,
  customer_id,
  job_id,
  purpose,
  status,
  issue_date,
  due_date,
  subtotal,
  tax,
  total,
  amount_paid,
  balance_due
)
values (
  '10000000-0000-4000-8000-000000000651',
  '10000000-0000-4000-8000-000000000001',
  'INV-2026-DEMO1',
  '10000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000631',
  'job',
  'draft',
  current_date,
  current_date,
  487.76,
  40.24,
  528.00,
  0,
  528.00
);

insert into public.invoice_lines (
  id,
  company_id,
  invoice_id,
  job_id,
  description,
  quantity,
  unit_price,
  subtotal,
  taxable,
  sort_order,
  source_estimate_line_id,
  line_kind,
  unit
)
select
  case line.id
    when '10000000-0000-4000-8000-000000000511'::uuid
      then '10000000-0000-4000-8000-000000000652'::uuid
    when '10000000-0000-4000-8000-000000000512'::uuid
      then '10000000-0000-4000-8000-000000000653'::uuid
    else '10000000-0000-4000-8000-000000000654'::uuid
  end,
  line.company_id,
  '10000000-0000-4000-8000-000000000651',
  '10000000-0000-4000-8000-000000000631',
  line.description,
  line.quantity,
  line.unit_price * line.multiplier,
  line.subtotal,
  line.taxable,
  line.sort_order,
  line.id,
  line.line_kind,
  line.unit
from public.estimate_lines line
where line.estimate_id = '10000000-0000-4000-8000-000000000501';

insert into public.payments (
  id,
  company_id,
  invoice_id,
  customer_id,
  provider,
  provider_payment_id,
  payment_type,
  status,
  amount,
  processed_at,
  idempotency_key
)
values (
  '10000000-0000-4000-8000-000000000655',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000651',
  '10000000-0000-4000-8000-000000000201',
  'stripe',
  'pi_storyops_local_deposit_1',
  'deposit',
  'succeeded',
  132.00,
  now() - interval '2 days',
  'deposit:10000000-0000-4000-8000-000000000521'
);

with fixture(receipt) as (
  values (
    jsonb_build_object(
      'schemaVersion', 'storyops-provider-receipt-v1',
      'provider', 'stripe',
      'eventId', 'evt_storyops_local_deposit_1',
      'eventType', 'checkout.session.completed',
      'objectId', 'cs_storyops_local_deposit_1',
      'objectKind', 'checkout',
      'action', 'payment_succeeded',
      'companyId', '10000000-0000-4000-8000-000000000001',
      'occurredAt', (now() - interval '2 days')::text,
      'quoteId', '10000000-0000-4000-8000-000000000521',
      'paymentIntentId', 'pi_storyops_local_deposit_1',
      'amountCents', 13200,
      'currency', 'usd'
    )
  )
)
insert into public.webhook_events (
  id,
  company_id,
  provider,
  provider_event_id,
  event_type,
  status,
  payload_hash,
  payload,
  processed_at
)
select
  '10000000-0000-4000-8000-000000000656',
  '10000000-0000-4000-8000-000000000001',
  'stripe',
  'evt_storyops_local_deposit_1',
  'checkout.session.completed',
  'processed',
  encode(extensions.digest(receipt::text, 'sha256'), 'hex'),
  receipt,
  now() - interval '2 days'
from fixture;
