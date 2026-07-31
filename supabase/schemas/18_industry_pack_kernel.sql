-- Remove exterior-cleaning vocabulary from the stable service-business kernel.
-- Industry packs still validate their own finite category and pricing-attribute
-- vocabularies before publication; the database stores bounded semantic codes
-- rather than maintaining one global list for every future trade.

alter table public.service_catalog
  drop constraint service_catalog_category_check;
alter table public.service_catalog
  add constraint service_catalog_category_code
  check (category ~ '^[a-z][a-z0-9_]{1,79}$');

alter table public.price_book_attribute_multipliers
  drop constraint price_book_attribute_multipliers_attribute_check;
alter table public.price_book_attribute_multipliers
  add constraint price_book_attribute_multiplier_code
  check (attribute ~ '^[a-z][a-z0-9_]{1,79}$');

-- The kernel intentionally keeps a small unit-safe measurement vocabulary.
-- Packs map their trade language onto these physical/count/time evidence kinds;
-- they do not introduce arbitrary units into deterministic price calculations.
alter table public.property_measurements
  drop constraint property_measurements_kind_check;
alter table public.property_measurements
  add constraint property_measurements_kind_check
  check (
    kind in (
      'area_sq_ft', 'length_linear_ft', 'height_ft', 'count', 'stories',
      'duration_hours'
    )
  );
alter table public.property_measurements
  drop constraint property_measurements_unit_check;
alter table public.property_measurements
  add constraint property_measurements_unit_check
  check (unit in ('sq_ft', 'linear_ft', 'ft', 'each', 'story', 'hour'));

comment on column public.service_catalog.category is
  'Bounded semantic category supplied by the active versioned industry pack; it is not a global exterior-services enum.';
comment on column public.price_book_attribute_multipliers.attribute is
  'Bounded deterministic pricing dimension supplied and validated by the active versioned industry pack.';
comment on column public.property_measurements.kind is
  'Kernel measurement evidence kind. Industry packs map domain labels to the bounded area, length, height, count, story, or duration vocabulary.';
