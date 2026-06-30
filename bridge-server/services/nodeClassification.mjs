/**
 * Node classification — maps a Meshtastic node to a TAK category and CoT type.
 *
 * A mesh node is a *device*, not a person. Emitting every node as `a-f-G-U-C`
 * (friendly ground COMBAT unit) makes repeaters and weather sensors all show up
 * in ATAK as soldiers. We classify by device role (with telemetry as a fallback)
 * into four categories, each mapped to a more appropriate CoT symbol:
 *
 *   unit            person/tracker on the team   → friendly ground unit
 *   sensor          reports environment data      → sensor equipment
 *   infrastructure  router / repeater (relay)      → comms/relay equipment
 *   radio           plain client node (default)    → generic radio/equipment
 *
 * The category→CoT-type map is configurable (cot.nodeTypes) so the exact symbols
 * can be tuned per deployment without code changes.
 */

const INFRA_ROLES = new Set(['ROUTER', 'ROUTER_CLIENT', 'REPEATER', 'ROUTER_LATE']);
const SENSOR_ROLES = new Set(['SENSOR']);
const UNIT_ROLES = new Set(['TAK', 'TAK_TRACKER', 'TRACKER']);

// Default friendly-affiliation symbols. Tunable via cot.nodeTypes.
export const DEFAULT_NODE_COT_TYPES = {
  unit: 'a-f-G-U-C',             // friendly ground unit, combat (person/tracker)
  sensor: 'a-f-G-E-S',           // friendly ground equipment — sensor
  infrastructure: 'a-f-G-E-X-N', // comms/relay equipment
  radio: 'a-f-G-E-X-C',          // generic radio/equipment (default client node)
};

export const CATEGORY_LABEL = {
  unit: 'Unit',
  sensor: 'Sensor',
  infrastructure: 'Relay',
  radio: 'Radio',
};

/** Classify a node into: unit | sensor | infrastructure | radio. */
export function classifyNode(node) {
  const role = String(node.role || '').toUpperCase();
  const hasEnvTelemetry =
    node.temperature != null || node.humidity != null || node.pressure != null;

  if (SENSOR_ROLES.has(role)) return 'sensor';
  if (INFRA_ROLES.has(role)) return 'infrastructure';
  if (UNIT_ROLES.has(role)) return 'unit';
  // No decisive role: a node reporting environment data is effectively a sensor.
  if (hasEnvTelemetry) return 'sensor';
  // Plain CLIENT / unknown role → a radio, NOT a combat unit.
  return 'radio';
}

/** Resolve a node's CoT type from its category and a (configurable) type map. */
export function nodeCotType(node, typeMap) {
  const category = classifyNode(node);
  const cotType =
    (typeMap && typeMap[category]) || DEFAULT_NODE_COT_TYPES[category] || 'a-f-G';
  return { category, cotType };
}
