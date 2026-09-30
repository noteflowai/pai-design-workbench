/**
 * Presentation-only live progress keyed by the client's request identity.
 *
 * Events describe native work as it happens (tool steps, staged geometry, render samples)
 * so the UI can show it while the durable record is still running. They never change
 * domain records, grant acceptance or trigger replay. Bounded memory; replay on subscribe.
 */
import { DomainError } from "./domain.js";

export type LiveEvent =
  | { kind: "step"; id: string; label: string; status: "running" | "done" | "failed"; detail?: string; which?: string }
  | { kind: "record"; recordKind: string; recordId: string }
  | { kind: "stage"; which: "baseline" | "candidate"; index: number; id: string; label: string; objects: string[]; url: string; sha256: string }
  | { kind: "ray"; which: "baseline" | "candidate"; origin: number[]; target: number[]; hit: number[] | null; firstHit: string | null; visible: boolean }
  | { kind: "render"; which: "baseline" | "candidate"; sample: number; samples: number }
  | { kind: "done"; state: string; recordId?: string; verdict?: string; detail?: string };
export type Stamped = LiveEvent & { seq: number; at: string };

interface Channel { events: Stamped[]; listeners: Set<(event: Stamped) => void>; done: boolean; touched: number; seq: number }

export class LiveBus {
  private channels = new Map<string, Channel>();
  constructor(private maxChannels = 200, private maxEvents = 600, private retainMs = 15 * 60_000) {}
  private channel(key: string): Channel {
    let channel = this.channels.get(key);
    if (!channel) {
      this.evict();
      channel = { events: [], listeners: new Set(), done: false, touched: Date.now(), seq: 0 };
      this.channels.set(key, channel);
    }
    channel.touched = Date.now();
    return channel;
  }
  private evict() {
    const now = Date.now();
    for (const [key, c] of this.channels) if (c.listeners.size === 0 && now - c.touched > this.retainMs) this.channels.delete(key);
    while (this.channels.size >= this.maxChannels) {
      const oldest = [...this.channels].filter(([, c]) => c.listeners.size === 0).sort(([, a], [, b]) => a.touched - b.touched)[0];
      if (!oldest) break;
      this.channels.delete(oldest[0]);
    }
  }
  publish(key: string, event: LiveEvent): void {
    const channel = this.channel(key);
    if (channel.done) return;
    // Render samples are high-frequency; keep only the latest per mode in the replay buffer.
    if (event.kind === "render") {
      let i = -1;
      channel.events.forEach((e, index) => { if (e.kind === "render" && e.which === event.which) i = index; });
      if (i >= 0) channel.events.splice(i, 1);
    }
    const stamped = { ...event, seq: ++channel.seq, at: new Date().toISOString() } as Stamped;
    if (channel.events.length < this.maxEvents) channel.events.push(stamped);
    if (event.kind === "done") channel.done = true;
    for (const listener of channel.listeners) { try { listener(stamped); } catch { /* Slow or closed subscribers never affect work. */ } }
  }
  subscribe(key: string, listener: (event: Stamped) => void): { replay: Stamped[]; done: boolean; close: () => void } {
    const listening = [...this.channels.values()].reduce((n, c) => n + c.listeners.size, 0);
    if (listening >= this.maxChannels) throw new DomainError("LIVE_STREAM_LIMIT", "Too many open live streams; durable records remain available", 429);
    const channel = this.channel(key);
    channel.listeners.add(listener);
    return { replay: [...channel.events], done: channel.done, close: () => { channel.listeners.delete(listener); channel.touched = Date.now(); } };
  }
  size() { return this.channels.size; }
}
