import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Location, WeatherError, geocode, getForecast } from './open-meteo.js';

// Scheduler (Day 18): deferred and periodic tasks that run inside this server
// process — so they keep going 24/7 on the VM whether or not anyone has the
// app open. Everything (tasks, collected samples, emitted events) lives in one
// JSON file; the app catches up on missed events whenever it reconnects.

const STORE_PATH = process.env.SCHEDULER_STORE ?? path.join(process.cwd(), 'data', 'scheduler.json');
const TICK_MS = Number(process.env.SCHEDULER_TICK_MS ?? 15_000);
/** Caps so a long-running task can't grow the store without bound. */
const MAX_SAMPLES_PER_TASK = 2_000;
const MAX_EVENTS = 1_000;

export const MIN_INTERVAL_MINUTES = 1;

export type TaskKind = 'weather_watch' | 'reminder';
export type TaskStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export interface Task {
  id: string;
  /** Chat the task was created from — passed by the client in `_meta`, never by the model. */
  ownerId?: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  /** Periodic when set, one-off otherwise. */
  intervalMinutes?: number;
  /** weather_watch: how often to emit an aggregated summary event. */
  summaryEveryMinutes?: number;
  /** Stop after this many runs (periodic tasks). */
  maxRuns?: number;
  /** reminder only. */
  message?: string;
  /** weather_watch only — resolved once at creation so a typo fails immediately, not hours later. */
  location?: Location;
  createdAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastSummaryAt?: string;
  runCount: number;
  lastError?: string;
  /** Short human-readable result of the latest run. */
  lastResult?: string;
}

export interface WeatherSample {
  at: string;
  temperature: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  conditions: string;
  /** WMO code range 51+ is some form of precipitation. */
  precipitating: boolean;
}

export type EventType = 'reminder' | 'summary' | 'error' | 'completed';

export interface TaskEvent {
  /** Monotonic per store — clients remember the last one they've seen. */
  seq: number;
  taskId: string;
  ownerId?: string;
  taskTitle: string;
  type: EventType;
  createdAt: string;
  text: string;
  data?: Record<string, unknown>;
}

interface StoreShape {
  tasks: Task[];
  samples: Record<string, WeatherSample[]>;
  events: TaskEvent[];
  nextSeq: number;
}

export interface WeatherAggregate {
  taskId: string;
  title: string;
  location: string;
  from: string;
  to: string;
  samples: number;
  temperature?: { min: number; max: number; avg: number; first: number; last: number; trend: number };
  feelsLike?: { min: number; max: number };
  humidityAvg?: number;
  windMax?: number;
  precipitatingSamples: number;
  conditions: Record<string, number>;
  latest?: WeatherSample;
}

export class SchedulerError extends Error {}

const round1 = (n: number) => Math.round(n * 10) / 10;
const signed = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n)}`;

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} ч ${minutes % 60} мин` : `${hours} ч`;
}

export function describeSchedule(task: Pick<Task, 'intervalMinutes' | 'nextRunAt' | 'maxRuns'>): string {
  if (!task.intervalMinutes) return `однократно, ${task.nextRunAt}`;
  const every =
    task.intervalMinutes % 60 === 0 ? `каждые ${task.intervalMinutes / 60} ч` : `каждые ${task.intervalMinutes} мин`;
  return task.maxRuns ? `${every}, до ${task.maxRuns} запусков` : every;
}

export class Scheduler {
  private store: StoreShape = { tasks: [], samples: {}, events: [], nextSeq: 1 };
  private timer?: NodeJS.Timeout;
  private running = false;
  private writeQueue: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    try {
      this.store = { ...this.store, ...JSON.parse(await fs.readFile(STORE_PATH, 'utf-8')) };
      console.log(`Scheduler: restored ${this.store.tasks.length} task(s) from ${STORE_PATH}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async createTask(input: {
    ownerId?: string;
    kind: TaskKind;
    title: string;
    city?: string;
    message?: string;
    delayMinutes: number;
    intervalMinutes?: number;
    summaryEveryMinutes?: number;
    maxRuns?: number;
  }): Promise<Task> {
    const now = Date.now();
    const task: Task = {
      id: randomUUID().slice(0, 8),
      ownerId: input.ownerId,
      kind: input.kind,
      title: input.title.trim(),
      status: 'active',
      intervalMinutes: input.intervalMinutes,
      maxRuns: input.intervalMinutes ? input.maxRuns : undefined,
      createdAt: new Date(now).toISOString(),
      nextRunAt: new Date(now + input.delayMinutes * 60_000).toISOString(),
      runCount: 0,
    };

    if (input.kind === 'weather_watch') {
      if (!input.city?.trim()) throw new SchedulerError('Для weather_watch нужен город (city)');
      if (!input.intervalMinutes) throw new SchedulerError('weather_watch — периодическая задача, укажи interval_minutes');
      task.location = await geocode(input.city);
      // Default: a summary every 4 collections — frequent enough to see
      // something, rare enough that each one aggregates a few data points.
      task.summaryEveryMinutes = Math.max(input.summaryEveryMinutes ?? input.intervalMinutes * 4, input.intervalMinutes);
      task.lastSummaryAt = task.createdAt;
    } else {
      if (!input.message?.trim()) throw new SchedulerError('Для reminder нужен текст напоминания (message)');
      task.message = input.message.trim();
    }

    this.store.tasks.push(task);
    await this.persist();
    return task;
  }

  listTasks(ownerId?: string, includeFinished = false): Task[] {
    return this.store.tasks.filter(
      (t) => (!ownerId || t.ownerId === ownerId) && (includeFinished || t.status === 'active' || t.status === 'paused'),
    );
  }

  getTask(id: string, ownerId?: string): Task {
    const task = this.store.tasks.find((t) => t.id === id && (!ownerId || t.ownerId === ownerId));
    if (!task) throw new SchedulerError(`Задача ${id} не найдена`);
    return task;
  }

  async setStatus(id: string, status: 'active' | 'paused' | 'cancelled', ownerId?: string): Promise<Task> {
    const task = this.getTask(id, ownerId);
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new SchedulerError(`Задача ${id} уже завершена (${task.status})`);
    }
    // Resuming never replays what was missed while paused — the next run is
    // due immediately, then the normal cadence continues from there.
    if (status === 'active' && task.status === 'paused' && Date.parse(task.nextRunAt) < Date.now()) {
      task.nextRunAt = new Date().toISOString();
    }
    task.status = status;
    await this.persist();
    return task;
  }

  events(afterSeq = 0, ownerId?: string, limit = 100): TaskEvent[] {
    return this.store.events.filter((e) => e.seq > afterSeq && (!ownerId || e.ownerId === ownerId)).slice(0, limit);
  }

  /** Aggregates a weather_watch task's samples over the last `periodHours` (default: everything since the last summary). */
  aggregate(taskId: string, ownerId?: string, periodHours?: number): WeatherAggregate {
    const task = this.getTask(taskId, ownerId);
    if (task.kind !== 'weather_watch') throw new SchedulerError('Сводка доступна только для задач weather_watch');
    const to = new Date();
    const from = periodHours
      ? new Date(to.getTime() - periodHours * 3_600_000)
      : new Date(task.lastSummaryAt ?? task.createdAt);
    return this.aggregateRange(task, from, to);
  }

  formatAggregate(a: WeatherAggregate): string {
    const period = formatDuration(Date.parse(a.to) - Date.parse(a.from));
    if (a.samples === 0 || !a.temperature) {
      return `Сводка «${a.title}» (${a.location}) за ${period}: замеров пока нет.`;
    }
    const t = a.temperature;
    const trend = Math.abs(t.trend) < 1 ? 'без изменений' : t.trend > 0 ? `рост на ${Math.round(t.trend)}°` : `падение на ${Math.round(-t.trend)}°`;
    const topConditions = Object.entries(a.conditions)
      .sort((x, y) => y[1] - x[1])
      .map(([name, count]) => `${name} (${count})`)
      .join(', ');
    const lines = [
      `Сводка «${a.title}» (${a.location}) за ${period}, замеров: ${a.samples}`,
      `Температура: ${signed(t.min)}…${signed(t.max)}°C, в среднем ${signed(t.avg)}°C, ${trend} (с ${signed(t.first)} до ${signed(t.last)}°C)`,
      `Ощущается: ${signed(a.feelsLike!.min)}…${signed(a.feelsLike!.max)}°C, влажность в среднем ${a.humidityAvg}%, ветер до ${a.windMax} м/с`,
      `Осадки: ${a.precipitatingSamples === 0 ? 'не было' : `в ${a.precipitatingSamples} из ${a.samples} замеров`}`,
      `Погода: ${topConditions}`,
    ];
    if (a.latest) lines.push(`Сейчас: ${signed(a.latest.temperature)}°C, ${a.latest.conditions}`);
    return lines.join('\n');
  }

  private aggregateRange(task: Task, from: Date, to: Date): WeatherAggregate {
    const samples = (this.store.samples[task.id] ?? []).filter((s) => {
      const at = Date.parse(s.at);
      return at > from.getTime() && at <= to.getTime();
    });
    const location = [task.location?.name, task.location?.country].filter(Boolean).join(', ');
    const aggregate: WeatherAggregate = {
      taskId: task.id,
      title: task.title,
      location,
      from: from.toISOString(),
      to: to.toISOString(),
      samples: samples.length,
      precipitatingSamples: samples.filter((s) => s.precipitating).length,
      conditions: {},
    };
    if (samples.length === 0) return aggregate;

    const temps = samples.map((s) => s.temperature);
    const feels = samples.map((s) => s.feelsLike);
    aggregate.temperature = {
      min: Math.min(...temps),
      max: Math.max(...temps),
      avg: round1(temps.reduce((a, b) => a + b, 0) / temps.length),
      first: temps[0],
      last: temps[temps.length - 1],
      trend: round1(temps[temps.length - 1] - temps[0]),
    };
    aggregate.feelsLike = { min: Math.min(...feels), max: Math.max(...feels) };
    aggregate.humidityAvg = Math.round(samples.reduce((a, s) => a + s.humidity, 0) / samples.length);
    aggregate.windMax = Math.max(...samples.map((s) => s.windSpeed));
    for (const s of samples) aggregate.conditions[s.conditions] = (aggregate.conditions[s.conditions] ?? 0) + 1;
    aggregate.latest = samples[samples.length - 1];
    return aggregate;
  }

  private async tick(): Promise<void> {
    // A slow run (weather API timing out) must not overlap with the next tick.
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const due = this.store.tasks.filter((t) => t.status === 'active' && Date.parse(t.nextRunAt) <= now);
      for (const task of due) await this.run(task);
      if (due.length) await this.persist();
    } catch (error) {
      console.error('Scheduler tick failed:', error);
    } finally {
      this.running = false;
    }
  }

  private async run(task: Task): Promise<void> {
    const now = new Date();
    task.runCount += 1;
    task.lastRunAt = now.toISOString();
    try {
      if (task.kind === 'reminder') {
        task.lastResult = task.message;
        this.emit(task, 'reminder', `⏰ ${task.message}`);
      } else {
        await this.collectWeather(task, now);
      }
      task.lastError = undefined;
    } catch (error) {
      const message = error instanceof WeatherError ? error.message : `Ошибка выполнения: ${(error as Error).message}`;
      task.lastError = message;
      this.emit(task, 'error', `Задача «${task.title}»: ${message}`);
    }

    const finished = !task.intervalMinutes || (task.maxRuns !== undefined && task.runCount >= task.maxRuns);
    if (finished) {
      if (task.kind === 'weather_watch') this.emitSummary(task, now);
      task.status = 'completed';
      if (task.intervalMinutes) this.emit(task, 'completed', `Задача «${task.title}» завершена, запусков: ${task.runCount}.`);
      return;
    }
    // Next run counts from now, not from the missed slot: after downtime the
    // task resumes its cadence instead of firing a burst of catch-up runs.
    task.nextRunAt = new Date(now.getTime() + task.intervalMinutes! * 60_000).toISOString();
  }

  private async collectWeather(task: Task, now: Date): Promise<void> {
    const forecast = await getForecast(task.location!, 1, 'daily');
    const c = forecast.current;
    const sample: WeatherSample = {
      at: now.toISOString(),
      temperature: c.temperature,
      feelsLike: c.feelsLike,
      humidity: c.humidity,
      windSpeed: c.windSpeed,
      conditions: c.conditions,
      precipitating: /дожд|морос|снег|ливен|гроза|град|зёрна/.test(c.conditions),
    };
    const samples = (this.store.samples[task.id] ??= []);
    samples.push(sample);
    if (samples.length > MAX_SAMPLES_PER_TASK) samples.splice(0, samples.length - MAX_SAMPLES_PER_TASK);
    task.lastResult = `${signed(c.temperature)}°C, ${c.conditions}`;

    const lastSummary = Date.parse(task.lastSummaryAt ?? task.createdAt);
    // Small slack so a summary due "exactly now" isn't pushed a whole interval later by tick jitter.
    if (now.getTime() - lastSummary >= task.summaryEveryMinutes! * 60_000 - TICK_MS) this.emitSummary(task, now);
  }

  private emitSummary(task: Task, now: Date): void {
    const aggregate = this.aggregateRange(task, new Date(task.lastSummaryAt ?? task.createdAt), now);
    task.lastSummaryAt = now.toISOString();
    if (aggregate.samples === 0) return;
    this.emit(task, 'summary', this.formatAggregate(aggregate), aggregate as unknown as Record<string, unknown>);
  }

  private emit(task: Task, type: EventType, text: string, data?: Record<string, unknown>): void {
    this.store.events.push({
      seq: this.store.nextSeq++,
      taskId: task.id,
      ownerId: task.ownerId,
      taskTitle: task.title,
      type,
      createdAt: new Date().toISOString(),
      text,
      data,
    });
    if (this.store.events.length > MAX_EVENTS) this.store.events.splice(0, this.store.events.length - MAX_EVENTS);
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.store);
    const write = async () => {
      await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
      // Write-then-rename so a crash mid-write never leaves a truncated store.
      await fs.writeFile(`${STORE_PATH}.tmp`, snapshot, 'utf-8');
      await fs.rename(`${STORE_PATH}.tmp`, STORE_PATH);
    };
    const current = this.writeQueue.then(write, write);
    this.writeQueue = current.catch(() => {});
    return current;
  }
}
