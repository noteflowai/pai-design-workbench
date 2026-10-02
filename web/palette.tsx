import { useEffect, useMemo, useRef, useState } from "react";

export interface Command { id: string; label: string; hint?: string; run: () => void }

/** Ctrl/⌘+K command palette, as in professional design tools. */
export function Palette({ commands, onAsk }: { commands: Command[]; onAsk?: (question: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); restore.current = document.activeElement as HTMLElement; setOpen(o => !o); setQuery(""); setActive(0);
      }
    };
    const onOpen = () => { restore.current = document.activeElement as HTMLElement; setOpen(true); setQuery(""); setActive(0); };
    window.addEventListener("keydown", onKey); window.addEventListener("pai-palette", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pai-palette", onOpen); };
  }, []);
  useEffect(() => { if (open) setTimeout(() => input.current?.focus(), 0); else restore.current?.focus?.(); }, [open]);
  const results = useMemo(() => {
    const hits = commands.filter(c => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(query.toLowerCase()));
    // As in AI-assisted design tools, free text that is not a command becomes a question to the assistant.
    return query.trim() && onAsk ? [...hits, { id: "ask", label: `问 AI：${query.trim()}`, hint: "↵", run: () => onAsk(query.trim()) }] : hits;
  }, [commands, query, onAsk]);
  if (!open) return null;
  const choose = (c?: Command) => { if (!c) return; setOpen(false); setTimeout(c.run, 0); };
  return <div className="palette-backdrop" onMouseDown={() => setOpen(false)}>
    <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板" onMouseDown={e => e.stopPropagation()}>
      <input ref={input} value={query} role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
        placeholder="输入命令或问题：CAD、扫描、视图、跳转…" onChange={e => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={e => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          if (e.key === "Enter") { e.preventDefault(); choose(results[active]); }
        }} />
      <ul id="palette-list" role="listbox">{results.map((c, i) => <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={i === active}
        onMouseEnter={() => setActive(i)} onClick={() => choose(c)}><span>{c.label}</span>{c.hint && <kbd>{c.hint}</kbd>}</li>)}
        {results.length === 0 && <li className="none">没有匹配的命令</li>}</ul>
    </div>
  </div>;
}
