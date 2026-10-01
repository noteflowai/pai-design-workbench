/** Shared client helpers. Durable records stay authoritative; live events are presentation only. */
export async function api<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  let r = await fetch(`/api${path}`, body === undefined ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = await r.json();
  const deadline = Date.now() + 360_000;
  while (r.status === 202) {
    const location = r.headers.get("Location");
    if (!location || !/^\/api\/(runs|scenes|cad|assistant\/plans)\/[a-f0-9-]+$/.test(location)) throw new Error("检查任务未提供可核验状态地址");
    if (Date.now() >= deadline) throw new Error("检查仍在运行；请刷新查看原请求回执。不要以新请求重复执行。");
    await new Promise(resolve => setTimeout(resolve, 2_000));
    r = await fetch(location);
    data = await r.json();
  }
  if (!r.ok) throw new Error(`${data.error}: ${data.message ?? "请求被拒绝"}`);
  return data as T;
}

export type LiveEvent = { seq: number; at: string } & (
  | { kind: "step"; id: string; label: string; status: "running" | "done" | "failed"; detail?: string; which?: string }
  | { kind: "record"; recordKind: string; recordId: string }
  | { kind: "stage"; which: "baseline" | "candidate"; index: number; id: string; label: string; objects: string[]; url: string; sha256: string }
  | { kind: "ray"; which: "baseline" | "candidate"; origin: number[]; target: number[]; hit: number[] | null; firstHit: string | null; visible: boolean }
  | { kind: "render"; which: "baseline" | "candidate"; sample: number; samples: number }
  | { kind: "done"; state: string; recordId?: string; verdict?: string; detail?: string });

/** Subscribe before starting work so no step is missed; resolves once the stream is open. */
export function openLive(requestId: string, onEvent: (event: LiveEvent) => void): Promise<() => void> {
  return new Promise(resolve => {
    if (typeof EventSource === "undefined") { resolve(() => {}); return; }
    const source = new EventSource(`/api/live/${requestId}`);
    const seen = new Set<number>();
    const close = () => source.close();
    const handle = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as LiveEvent;
        if (seen.has(event.seq)) return;
        seen.add(event.seq); onEvent(event);
        if (event.kind === "done") close();
      } catch { /* Ignore malformed presentation events. */ }
    };
    for (const kind of ["step", "record", "stage", "ray", "render", "done"]) source.addEventListener(kind, handle as EventListener);
    let settled = false;
    const ready = () => { if (!settled) { settled = true; resolve(close); } };
    source.onopen = ready;
    source.onerror = () => { if (source.readyState === EventSource.CLOSED) ready(); };
    setTimeout(ready, 1_500); // Never block the confirmed action on a slow presentation stream.
  });
}

export function requestIdFor(key: string): string {
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID(); sessionStorage.setItem(key, id); return id;
}
