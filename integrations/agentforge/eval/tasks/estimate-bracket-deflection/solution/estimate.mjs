// First-principles scaling from the measured reference: plate bending stiffness ~ t^3 (softened to t^2.5 by the
// ribs carrying part of the moment), and a wider plate puts the bore farther from the ribs (~ W^0.7).
import { readFileSync } from 'node:fs';
const ref = JSON.parse(readFileSync(new URL('./reference.json', import.meta.url), 'utf8'));
export function estimate({ thickness, width }) {
  const r = ref.parameters;
  return ref.deflectionMm * (r.thickness / thickness) ** 2.5 * (width / r.width) ** 0.7;
}
