/** Shared client helpers. Durable records stay authoritative; live events are presentation only. */

/**
 * The hosted ALB answers an expired login session with a redirect to Cognito, before the request reaches the
 * workbench (nothing ran). A fetch cannot follow that cross-origin redirect, so sign in again with a top-level
 * navigation of this tab: it starts a fresh login whose state cookie is valid, instead of the user reaching the
 * login from a stale tab or a reloaded callback URL (which the ALB rejects with 401).
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const r = await fetch(input, { ...init, redirect: "manual" });
  if (r.type === "opaqueredirect") {
    location.reload(); // (assigning the same URL with a #fragment would not leave the page)
    throw new Error("登录已过期，正在重新登录（请求未执行）");
  }
  return r;
}

export async function api<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  let r = await authFetch(`/api${path}`, body === undefined ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = await r.json();
  // Sweeps run up to 36 native builds; other native work stays within the 6-minute budget.
  const deadline = Date.now() + (path.endsWith("/cad-sweeps") || path.endsWith("/cad-optimizations") ? 2_400_000 : path.endsWith("/cad") ? 900_000 : path.endsWith("/aero") ? 7_200_000 : 360_000);
  while (r.status === 202) {
    const location = r.headers.get("Location");
    if (!location || !/^\/api\/(runs|scenes|cad|aero|cad-sweeps|cad-optimizations|autopilots|assistant\/plans)\/[a-f0-9-]+$/.test(location)) throw new Error("检查任务未提供可核验状态地址");
    if (Date.now() >= deadline) throw new Error("检查仍在运行；请刷新查看原请求回执。不要以新请求重复执行。");
    await new Promise(resolve => setTimeout(resolve, 2_000));
    r = await authFetch(location);
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
