import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Forecast, HOURLY_STEP, MAX_DAYS, MAX_HOURLY_DAYS, WeatherError, geocode, getForecast } from './open-meteo.js';
import { MIN_INTERVAL_MINUTES, Scheduler, SchedulerError, Task, describeSchedule } from './scheduler.js';

/** The client (our backend) tags every call with the chat it came from; the model never sees or sets this. */
const OWNER_META_KEY = 'advent/chatId';

function ownerOf(extra: { _meta?: Record<string, unknown> }): string | undefined {
  const owner = extra._meta?.[OWNER_META_KEY];
  return typeof owner === 'string' && owner ? owner : undefined;
}

function formatTask(t: Task): string {
  const target = t.kind === 'weather_watch' ? `погода: ${t.location?.name}` : `напоминание: «${t.message}»`;
  const parts = [`[${t.id}] «${t.title}» — ${target}; ${describeSchedule(t)}; статус ${t.status}; запусков: ${t.runCount}`];
  if (t.status === 'active') parts.push(`следующий запуск ${t.nextRunAt}`);
  if (t.kind === 'weather_watch' && t.summaryEveryMinutes) parts.push(`сводка каждые ${t.summaryEveryMinutes} мин`);
  if (t.lastResult) parts.push(`последний результат: ${t.lastResult}`);
  if (t.lastError) parts.push(`ошибка: ${t.lastError}`);
  return parts.join('; ');
}

function toolError(error: unknown) {
  if (error instanceof WeatherError || error instanceof SchedulerError) {
    return { content: [{ type: 'text' as const, text: error.message }], isError: true };
  }
  throw error;
}

const round = (n: number) => Math.round(n);
const signed = (n: number) => `${n > 0 ? '+' : ''}${round(n)}`;

/** Plain-text rendering for the model — compact, one line per row, units spelled out once. */
function formatForecast(f: Forecast, notes: string[]): string {
  const { location: loc, current: now, units } = f;
  const place = [loc.name, loc.region !== loc.name ? loc.region : undefined, loc.country].filter(Boolean).join(', ');
  const lines = [
    `Погода: ${place} (${loc.latitude.toFixed(2)}, ${loc.longitude.toFixed(2)}, часовой пояс ${loc.timezone})`,
    `Сейчас (${now.time.replace('T', ' ')}): ${signed(now.temperature)}${units.temperature}, ощущается как ${signed(now.feelsLike)}${units.temperature}, ${now.conditions}, влажность ${now.humidity}%, ветер ${now.windDirection} ${now.windSpeed} ${units.windSpeed}`,
    '',
    `Прогноз по дням (${f.daily.length}):`,
    ...f.daily.map(
      (d) =>
        `${d.date}: ${signed(d.temperatureMin)}…${signed(d.temperatureMax)}${units.temperature}, ${d.conditions}, осадки ${d.precipitationSum} ${units.precipitation}` +
        (d.precipitationProbability !== null ? ` (вероятность ${d.precipitationProbability}%)` : '') +
        `, ветер до ${d.windSpeedMax} ${units.windSpeed}` +
        (d.uvIndexMax !== null ? `, УФ ${d.uvIndexMax}` : '') +
        `, восход ${d.sunrise.slice(11)}, закат ${d.sunset.slice(11)}`,
    ),
  ];
  if (f.hourly) {
    lines.push('', `Почасовой прогноз (каждые ${HOURLY_STEP} ч):`);
    lines.push(
      ...f.hourly.map(
        (h) =>
          `${h.time.replace('T', ' ')}: ${signed(h.temperature)}${units.temperature}, ${h.conditions}` +
          (h.precipitationProbability !== null ? `, осадки ${h.precipitationProbability}%` : '') +
          (h.precipitation > 0 ? ` (${h.precipitation} ${units.precipitation})` : '') +
          `, ветер ${h.windSpeed} ${units.windSpeed}`,
      ),
    );
  }
  if (notes.length) lines.push('', ...notes.map((n) => `Примечание: ${n}`));
  lines.push('', 'Источник: Open-Meteo.com');
  return lines.join('\n');
}

const locationSchema = z.object({
  name: z.string(),
  country: z.string().optional(),
  region: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string(),
});

const outputSchema = {
  location: locationSchema,
  units: z.object({ temperature: z.string(), precipitation: z.string(), windSpeed: z.string() }),
  current: z.object({
    time: z.string(),
    temperature: z.number(),
    feelsLike: z.number(),
    humidity: z.number(),
    windSpeed: z.number(),
    windDirection: z.string(),
    conditions: z.string(),
  }),
  daily: z.array(
    z.object({
      date: z.string(),
      conditions: z.string(),
      temperatureMin: z.number(),
      temperatureMax: z.number(),
      precipitationSum: z.number(),
      precipitationProbability: z.number().nullable(),
      windSpeedMax: z.number(),
      uvIndexMax: z.number().nullable(),
      sunrise: z.string(),
      sunset: z.string(),
    }),
  ),
  hourly: z
    .array(
      z.object({
        time: z.string(),
        conditions: z.string(),
        temperature: z.number(),
        precipitationProbability: z.number().nullable(),
        precipitation: z.number(),
        windSpeed: z.number(),
      }),
    )
    .optional(),
  notes: z.array(z.string()),
};

/** One server instance per request (the HTTP transport runs stateless), so this must stay cheap. */
export function createWeatherServer(scheduler: Scheduler): McpServer {
  const server = new McpServer({ name: 'advent-weather', version: '0.2.0' });

  server.registerTool(
    'get_weather_forecast',
    {
      title: 'Прогноз погоды',
      description:
        'Текущая погода и прогноз для города: температура, осадки, ветер, УФ-индекс, восход/закат. ' +
        'Используй, когда пользователь спрашивает о погоде, о том, что надеть, брать ли зонт, или планирует что-то на улице.',
      inputSchema: {
        city: z
          .string()
          .min(1)
          .describe(
            'Название города на любом языке, например «Минск» или «London». Если название неоднозначное, уточни страной через запятую: «Париж, Франция» или «Paris, US».',
          ),
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_DAYS)
          .default(3)
          .describe(`Сколько дней прогноза вернуть, начиная с сегодня (1–${MAX_DAYS}).`),
        detail: z
          .enum(['daily', 'hourly'])
          .default('daily')
          .describe(
            `Детализация: "daily" — сводка по дням; "hourly" — дополнительно почасовой прогноз с шагом ${HOURLY_STEP} ч (не больше ${MAX_HOURLY_DAYS} дней).`,
          ),
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ city, days, detail }) => {
      const notes: string[] = [];
      let effectiveDays = days;
      if (detail === 'hourly' && days > MAX_HOURLY_DAYS) {
        effectiveDays = MAX_HOURLY_DAYS;
        notes.push(`почасовой прогноз ограничен ${MAX_HOURLY_DAYS} днями — запрошено ${days}, возвращено ${MAX_HOURLY_DAYS}.`);
      }
      try {
        const location = await geocode(city);
        const forecast = await getForecast(location, effectiveDays, detail);
        return {
          content: [{ type: 'text', text: formatForecast(forecast, notes) }],
          structuredContent: { ...forecast, notes },
        };
      } catch (error) {
        // Tool-level errors go back as a result the model can read and react
        // to ("city not found — ask the user"), not as a protocol error.
        if (error instanceof WeatherError) {
          return { content: [{ type: 'text', text: error.message }], isError: true };
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'schedule_task',
    {
      title: 'Создать фоновую задачу',
      description:
        'Создаёт фоновую задачу, которая выполняется по расписанию на сервере 24/7, даже когда пользователь не в чате. ' +
        'Виды: "weather_watch" — периодически собирает текущую погоду в городе и регулярно присылает агрегированную сводку (мин/макс/средняя температура, тренд, осадки); ' +
        '"reminder" — напоминание, однократное (через delay_minutes) или повторяющееся (interval_minutes). ' +
        'Используй, когда пользователь просит что-то делать регулярно, следить, напоминать или присылать сводку. Результаты придут в чат автоматически.',
      inputSchema: {
        kind: z.enum(['weather_watch', 'reminder']).describe('Тип задачи.'),
        title: z.string().min(1).max(80).describe('Короткое название задачи для списка, например «Погода в Минске» или «Размяться».'),
        city: z.string().optional().describe('weather_watch: город, как в get_weather_forecast («Минск», «Paris, US»).'),
        message: z.string().optional().describe('reminder: текст напоминания, который придёт пользователю.'),
        delay_minutes: z
          .number()
          .int()
          .min(0)
          .max(60 * 24 * 30)
          .default(0)
          .describe('Через сколько минут первый запуск (0 — сразу). Для «напомни через 20 минут» — 20.'),
        interval_minutes: z
          .number()
          .int()
          .min(MIN_INTERVAL_MINUTES)
          .max(60 * 24 * 7)
          .optional()
          .describe('Период повтора в минутах. Не указывай для однократного напоминания. Для weather_watch обязателен.'),
        summary_every_minutes: z
          .number()
          .int()
          .min(MIN_INTERVAL_MINUTES)
          .optional()
          .describe('weather_watch: как часто присылать сводку (по умолчанию — раз в 4 замера).'),
        max_runs: z.number().int().min(1).optional().describe('Для периодических задач: остановиться после стольких запусков.'),
      },
    },
    async (args, extra) => {
      try {
        const task = await scheduler.createTask({
          ownerId: ownerOf(extra),
          kind: args.kind,
          title: args.title,
          city: args.city,
          message: args.message,
          delayMinutes: args.delay_minutes,
          intervalMinutes: args.interval_minutes,
          summaryEveryMinutes: args.summary_every_minutes,
          maxRuns: args.max_runs,
        });
        return {
          content: [{ type: 'text', text: `Задача создана: ${formatTask(task)}` }],
          structuredContent: { task },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_scheduled_tasks',
    {
      title: 'Список фоновых задач',
      description: 'Фоновые задачи этого чата: расписание, статус, число запусков, последний результат.',
      inputSchema: {
        include_finished: z.boolean().default(false).describe('Показать также завершённые и отменённые.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ include_finished }, extra) => {
      const tasks = scheduler.listTasks(ownerOf(extra), include_finished);
      return {
        content: [{ type: 'text', text: tasks.length ? tasks.map(formatTask).join('\n') : 'Фоновых задач нет.' }],
        structuredContent: { tasks },
      };
    },
  );

  server.registerTool(
    'get_task_summary',
    {
      title: 'Сводка по фоновой задаче',
      description:
        'Агрегированный результат задачи weather_watch по собранным замерам: мин/макс/средняя температура, тренд, осадки, преобладающая погода. ' +
        'По умолчанию — с момента последней сводки; period_hours — за последние N часов.',
      inputSchema: {
        task_id: z.string().describe('id задачи из list_scheduled_tasks.'),
        period_hours: z.number().min(0.1).max(24 * 30).optional().describe('За сколько последних часов агрегировать.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ task_id, period_hours }, extra) => {
      try {
        const aggregate = scheduler.aggregate(task_id, ownerOf(extra), period_hours);
        return {
          content: [{ type: 'text', text: scheduler.formatAggregate(aggregate) }],
          structuredContent: { ...aggregate },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'set_task_status',
    {
      title: 'Пауза / возобновление / отмена задачи',
      description: 'Приостановить (paused), возобновить (active) или отменить (cancelled) фоновую задачу.',
      inputSchema: {
        task_id: z.string().describe('id задачи из list_scheduled_tasks.'),
        status: z.enum(['active', 'paused', 'cancelled']),
      },
    },
    async ({ task_id, status }, extra) => {
      try {
        const task = await scheduler.setStatus(task_id, status, ownerOf(extra));
        return { content: [{ type: 'text', text: formatTask(task) }], structuredContent: { task } };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_task_events',
    {
      title: 'События фоновых задач',
      description:
        'Результаты, которые фоновые задачи выдали сами: сработавшие напоминания, периодические сводки, ошибки. ' +
        'after_seq — вернуть только события новее этого номера.',
      inputSchema: {
        after_seq: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ after_seq, limit }, extra) => {
      const events = scheduler.events(after_seq, ownerOf(extra), limit);
      return {
        content: [
          {
            type: 'text',
            text: events.length
              ? events.map((e) => `#${e.seq} ${e.createdAt} [${e.taskTitle}] ${e.text}`).join('\n\n')
              : 'Новых событий нет.',
          },
        ],
        structuredContent: { events, lastSeq: events.length ? events[events.length - 1].seq : after_seq },
      };
    },
  );

  return server;
}
