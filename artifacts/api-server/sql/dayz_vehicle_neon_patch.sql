-- Optional one-time Neon patch for DayZ vehicle metadata used by the Discord shop.
-- Safe to run more than once.

INSERT INTO dayz_items (class_name, popular_name, image_url, spawn_event_name, enabled, updated_at)
VALUES
  ('OffroadHatchback', 'Ada 4x4', NULL, 'VehicleOffroadHatchback', true, NOW()),
  ('OffroadHatchback_Blue', 'Ada 4x4 Blue', NULL, 'VehicleOffroadHatchback', true, NOW()),
  ('OffroadHatchback_White', 'Ada 4x4 White', NULL, 'VehicleOffroadHatchback', true, NOW()),
  ('Truck_01_Covered', 'M3S Covered', NULL, 'VehicleTruck01', true, NOW()),
  ('Truck_01_Covered_Blue', 'M3S Covered Blue', NULL, 'VehicleTruck01', true, NOW()),
  ('Truck_01_Covered_Grey', 'M3S Covered Grey', NULL, 'VehicleTruck01', true, NOW()),
  ('Truck_01_Covered_Orange', 'M3S Covered Orange', NULL, 'VehicleTruck01', true, NOW()),
  ('Truck_01_Cargo', 'M3S Cargo Chassis', NULL, 'VehicleTruck01', true, NOW()),
  ('Truck_01_Cargo_Blue', 'M3S Cargo Chassis Blue', NULL, 'VehicleTruck01', true, NOW()),
  ('Truck_01_Cargo_Grey', 'M3S Cargo Chassis Grey', NULL, 'VehicleTruck01', true, NOW()),
  ('Truck_01_Cargo_Orange', 'M3S Cargo Chassis Orange', NULL, 'VehicleTruck01', true, NOW()),
  ('M1025', 'M1025', NULL, 'VehicleM1025', true, NOW())
ON CONFLICT (class_name)
DO UPDATE SET
  popular_name = EXCLUDED.popular_name,
  spawn_event_name = EXCLUDED.spawn_event_name,
  enabled = dayz_items.enabled,
  updated_at = NOW();
