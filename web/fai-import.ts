/**
 * First-article import: map a measuring-room export onto the inspection plan. Nothing is judged here; the server
 * judges every value against the frozen tolerance. Pure functions (no DOM), so they are unit-tested in Node.
 *
 * - CSV / TSV: each row "characteristic id or name, measured value, ..." (other columns ignored).
 * - QIF 3.0 Results (ISO 23952): every <…CharacteristicMeasurement> with a numeric <Value> is joined through its
 *   <CharacteristicItemId> to the <…CharacteristicItem> of that id, and matched by the item's <Name> or <Designator>.
 *   QIF values are in the file's primary linear unit; anything other than millimetres is converted with the file's
 *   own <UnitConversion><Factor> (to metres), and refused when the factor is missing.
 */
export interface PlanItem { id: string; label: string }
export interface Imported { values: Record<string, string>; unmatched: string[]; format: "csv" | "qif"; unit?: string; note?: string }

const norm = (x: string) => x.toLowerCase().replace(/[\s"'⌀ø()（）_-]/g, "");
const keyMap = (plan: PlanItem[]) => new Map(plan.flatMap(p => [[norm(p.id), p.id], [norm(p.label), p.id]] as [string, string][]));
const NUMBER = /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/;

export function matchCsv(text: string, plan: PlanItem[]): Imported {
  const byKey = keyMap(plan);
  const values: Record<string, string> = {}, unmatched: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(/[,;\t]/).map(c => c.trim());
    if (!cells[0]) continue;
    const id = byKey.get(norm(cells[0])), value = cells.slice(1).find(c => NUMBER.test(c));
    if (id && value !== undefined) values[id] = value; else if (!/^(id|characteristic|特性|name)$/i.test(cells[0])) unmatched.push(cells[0]);
  }
  return { values, unmatched, format: "csv" };
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];

export function matchQif(xml: string, plan: PlanItem[]): Imported {
  if (!/<QIFDocument[\s>]/.test(xml)) throw new Error("不是 QIF 文档（缺少 QIFDocument）");
  const byKey = keyMap(plan);
  // Primary linear unit and its factor to metres (FileUnits/PrimaryUnits/LinearUnit).
  const linear = /<PrimaryUnits>[\s\S]*?<LinearUnit>([\s\S]*?)<\/LinearUnit>/.exec(xml)?.[1] ?? "";
  const unit = tag(linear, "UnitName") ?? "mm";
  const factor = Number(tag(linear, "Factor"));
  const toMm = /^(mm|millimet(er|re)s?)$/i.test(unit) ? 1 : Number.isFinite(factor) && factor > 0 ? factor * 1000 : NaN;
  if (!Number.isFinite(toMm)) throw new Error(`QIF 线性单位 ${unit} 没有换算系数，无法换算成 mm`);
  const items = new Map<string, string[]>();
  for (const m of xml.matchAll(/<(\w+)CharacteristicItem\s+id="(\d+)"[^>]*>([\s\S]*?)<\/\1CharacteristicItem>/g)) {
    items.set(m[2], [tag(m[3], "Name"), tag(m[3], "Designator")].filter((x): x is string => Boolean(x)));
  }
  const values: Record<string, string> = {}, unmatched: string[] = [];
  for (const m of xml.matchAll(/<(\w+)CharacteristicMeasurement\s+id="\d+"[^>]*>([\s\S]*?)<\/\1CharacteristicMeasurement>/g)) {
    const itemId = tag(m[2], "CharacteristicItemId"), value = tag(m[2], "Value");
    if (!itemId || value === undefined || !NUMBER.test(value)) continue;
    const names = items.get(itemId) ?? [`#${itemId}`];
    const id = names.map(n => byKey.get(norm(n))).find(Boolean);
    // Angles are not converted (QIF has a separate angular unit); every plan characteristic here is linear or mass.
    if (id) values[id] = String(Math.round(Number(value) * toMm * 1e6) / 1e6);
    else unmatched.push(`${m[1]} ${names[0]}`);
  }
  return { values, unmatched, format: "qif", unit, ...(toMm !== 1 ? { note: `已从 ${unit} 换算为 mm` } : {}) };
}

/** Pick the parser from the file name or content. */
export function matchReport(name: string, text: string, plan: PlanItem[]): Imported {
  return /\.qif$/i.test(name) || /<QIFDocument[\s>]/.test(text.slice(0, 2000)) ? matchQif(text, plan) : matchCsv(text, plan);
}
