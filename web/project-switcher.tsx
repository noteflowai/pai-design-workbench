import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../src/contracts";
import type { Lifecycle } from "../src/lifecycle";
import { MATURITY } from "./context";

const RECENT_KEY = "pai-recent-projects", RECENT_MAX = 5;
export const recentProjects = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]").filter((x: unknown) => typeof x === "string"); } catch { return []; } };
export const rememberProject = (id: string) => localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentProjects().filter(x => x !== id)].slice(0, RECENT_MAX)));

const STATE_LABEL: Record<string, string> = { released: MATURITY.released[0], "in-review": MATURITY["in-review"][0], "superseded-only": "已被取代", none: "设计中" };
const day = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

type Row = { project: Project; group: string };

/**
 * Project switcher, as in Linear/Figma/GitHub: the current task on the trigger; a popover with search, recently opened
 * tasks and every task newest first. Each row shows revision, release state, creation time and a short id, so tasks
 * with the same title can be told apart.
 */
export function ProjectSwitcher({ projects, lifecycles, current, onSelect }: {
  projects: Project[]; lifecycles?: Record<string, Lifecycle>; current?: Project; onSelect(id: string): void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLUListElement>(null);
  const rows: Row[] = useMemo(() => {
    const newest = [...projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const q = query.trim().toLowerCase();
    if (q) return newest.filter(p => `${p.title} ${p.intendedDecision} ${p.id}`.toLowerCase().includes(q)).map(project => ({ project, group: "搜索结果" }));
    const byId = new Map(projects.map(p => [p.id, p]));
    const recent = recentProjects().map(id => byId.get(id)).filter((p): p is Project => Boolean(p));
    const seen = new Set(recent.map(p => p.id));
    return [...recent.map(project => ({ project, group: "最近打开" })), ...newest.filter(p => !seen.has(p.id)).map(project => ({ project, group: `全部任务（${projects.length}，最新在前）` }))];
  }, [projects, query, open]); // re-read recent tasks each time it opens
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener("mousedown", close); return () => removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => { list.current?.querySelector(`[aria-selected="true"]`)?.scrollIntoView({ block: "nearest" }); }, [active, open]);
  const show = () => { setQuery(""); const i = rows.findIndex(r => r.project.id === current?.id); setActive(Math.max(i, 0)); setOpen(true); };
  const choose = (r?: Row) => { if (!r) return; setOpen(false); trigger.current?.focus(); onSelect(r.project.id); };
  const label = current ? `${current.title} · v${current.revision}` : "选择任务";
  return <div className="switcher" ref={root}>
    <button ref={trigger} type="button" className="switcher-trigger" aria-haspopup="dialog" aria-expanded={open}
      aria-label={`选择已有任务：${label}`} title={label} onClick={() => open ? setOpen(false) : show()}>
      <span className="switcher-title">{current?.title ?? "选择任务"}</span>{current && <span className="switcher-rev">v{current.revision}</span>}
      <span aria-hidden="true" className="switcher-caret">▾</span></button>
    {open && <div className="switcher-pop" role="dialog" aria-label="切换任务">
      <input autoFocus value={query} role="combobox" aria-expanded="true" aria-controls="switcher-list" aria-autocomplete="list"
        aria-activedescendant={rows[active] ? `sw-${rows[active].project.id}` : undefined} aria-label="搜索任务（标题、决策或编号）"
        placeholder={`搜索 ${projects.length} 个任务…`} onChange={e => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={e => {
          if (e.key === "Escape") { e.preventDefault(); setOpen(false); trigger.current?.focus(); }
          if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, rows.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          if (e.key === "Enter") { e.preventDefault(); choose(rows[active]); }
        }} />
      <ul id="switcher-list" role="listbox" ref={list} aria-label="任务">
        {rows.map((r, i) => {
          const state = lifecycles?.[r.project.id]?.maturity.state ?? "none";
          const header = i === 0 || rows[i - 1].group !== r.group;
          return [header && <li key={`g-${r.group}`} className="sw-group" role="presentation">{r.group}</li>,
            <li key={`${r.group}-${r.project.id}`} id={`sw-${r.project.id}`} role="option" aria-selected={i === active}
            aria-current={r.project.id === current?.id ? "true" : undefined} onMouseEnter={() => setActive(i)} onClick={() => choose(r)}>
            <span className="sw-title">{r.project.title}</span>
            <span className="sw-meta">v{r.project.revision} · <span className={`sw-state s-${state}`}>{STATE_LABEL[state] ?? state}</span> · {day(r.project.createdAt)} · <code>{r.project.id.slice(0, 6)}</code></span>
          </li>];
        })}
        {rows.length === 0 && <li className="none" role="presentation">没有匹配的任务</li>}
      </ul>
    </div>}
  </div>;
}
