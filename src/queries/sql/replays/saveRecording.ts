import { gzipSync } from 'node:zlib';
import clickhouse from '@/lib/clickhouse';
import { uuid } from '@/lib/crypto';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import kafka from '@/lib/kafka';
import prisma from '@/lib/prisma';

const RRWEB_TYPE_FULL_SNAPSHOT = 2;
const RRWEB_TYPE_INCREMENTAL = 3;
const RRWEB_TYPE_META = 4;
const RRWEB_TYPE_CUSTOM = 5;
const RRWEB_SOURCE_VIEWPORT_RESIZE = 4;

export interface SaveRecordingArgs {
  websiteId: string;
  sessionId: string;
  visitId: string;
  chunkIndex: number;
  events: any[];
  eventCount: number;
  startedAt: Date;
  endedAt: Date;
}

export async function saveRecording(args: SaveRecordingArgs) {
  const result = await runQuery({
    [PRISMA]: () => relationalQuery(args),
    [CLICKHOUSE]: () => clickhouseQuery(args),
  });

  // rrweb-backed heatmap previews are intentionally relational-only.
  if (!clickhouse.enabled) {
    try {
      await upsertHeatmapReplayPreviews(args);
    } catch (error) {
      console.error('Failed to save heatmap replay preview', error);
    }
  }

  return result;
}

async function relationalQuery({
  websiteId,
  sessionId,
  visitId,
  chunkIndex,
  events,
  eventCount,
  startedAt,
  endedAt,
}: SaveRecordingArgs) {
  const compressed = gzipSync(Buffer.from(JSON.stringify(events), 'utf-8'));

  return prisma.client.sessionReplay.create({
    data: {
      id: uuid(),
      websiteId,
      sessionId,
      visitId,
      chunkIndex,
      events: compressed as any,
      eventCount,
      startedAt,
      endedAt,
    },
  });
}

async function clickhouseQuery({
  websiteId,
  sessionId,
  visitId,
  chunkIndex,
  events,
  eventCount,
  startedAt,
  endedAt,
}: SaveRecordingArgs) {
  const { insert, getUTCString } = clickhouse;
  const { sendMessage } = kafka;

  const message = {
    replay_id: uuid(),
    website_id: websiteId,
    session_id: sessionId,
    visit_id: visitId,
    chunk_index: chunkIndex,
    events: JSON.stringify(events),
    event_count: eventCount,
    started_at: getUTCString(startedAt),
    ended_at: getUTCString(endedAt),
  };

  if (kafka.enabled) {
    return sendMessage('session_replay', message);
  }

  return insert('session_replay', [message]);
}

interface HeatmapReplayPreviewRow {
  websiteId: string;
  sessionId: string;
  visitId: string;
  urlPath: string;
  viewportW: number;
  viewportH: number;
  replayChunkIndex: number;
  replayEventIndex: number;
  replayTimeMs: number | null;
}

function safePathname(href: unknown): string | null {
  if (typeof href !== 'string') {
    return null;
  }

  try {
    return new URL(href).pathname || '/';
  } catch {
    return href.startsWith('/') ? href.split(/[?#]/)[0] : null;
  }
}

function toBigIntOrNull(value: number | null) {
  return value === null ? null : BigInt(Math.trunc(value));
}

function extractHeatmapReplayPreviewRows({
  websiteId,
  sessionId,
  visitId,
  chunkIndex,
  events,
}: Pick<SaveRecordingArgs, 'websiteId' | 'sessionId' | 'visitId' | 'chunkIndex' | 'events'>) {
  const latestByKey = new Map<string, HeatmapReplayPreviewRow>();
  let urlPath: string | null = null;
  let viewportW: number | null = null;
  let viewportH: number | null = null;

  for (const [eventIndex, event] of events.entries()) {
    if (!event || typeof event !== 'object') {
      continue;
    }

    const replayTimeMs =
      typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
        ? Math.trunc(event.timestamp)
        : null;

    if (event.type === RRWEB_TYPE_META && event.data) {
      const nextPath = safePathname(event.data.href);

      if (nextPath) {
        urlPath = nextPath;
      }

      if (typeof event.data.width === 'number') {
        viewportW = Math.trunc(event.data.width);
      }

      if (typeof event.data.height === 'number') {
        viewportH = Math.trunc(event.data.height);
      }

      continue;
    }

    if (event.type === RRWEB_TYPE_CUSTOM && event.data?.tag === 'url-change') {
      const nextPath = safePathname(event.data.payload?.url);

      if (nextPath) {
        urlPath = nextPath;
      }

      continue;
    }

    if (event.type === RRWEB_TYPE_INCREMENTAL && event.data?.source === RRWEB_SOURCE_VIEWPORT_RESIZE) {
      if (typeof event.data.width === 'number') {
        viewportW = Math.trunc(event.data.width);
      }

      if (typeof event.data.height === 'number') {
        viewportH = Math.trunc(event.data.height);
      }
    }

    if (
      !urlPath ||
      !viewportW ||
      !viewportH ||
      (event.type !== RRWEB_TYPE_FULL_SNAPSHOT &&
        event.type !== RRWEB_TYPE_INCREMENTAL &&
        event.type !== RRWEB_TYPE_CUSTOM)
    ) {
      continue;
    }

    const key = `${urlPath}:${viewportW}x${viewportH}`;

    latestByKey.set(key, {
      websiteId,
      sessionId,
      visitId,
      urlPath,
      viewportW,
      viewportH,
      replayChunkIndex: chunkIndex,
      replayEventIndex: eventIndex,
      replayTimeMs,
    });
  }

  return Array.from(latestByKey.values());
}

function getSchema() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return null;
  }

  try {
    const connectionUrl = new URL(databaseUrl);

    return connectionUrl.searchParams.get('schema');
  } catch {
    return null;
  }
}

async function rawExecute(sql: string, data: Record<string, any> = {}) {
  const params: any[] = [];
  const schema = getSchema();

  if (schema) {
    await prisma.client.$executeRawUnsafe(`SET search_path TO "${schema}";`);
  }

  const query = sql.replaceAll(/\{\{\s*(\w+)(::\w+)?\s*}}/g, (...args) => {
    const [, name, type] = args;

    params.push(data[name]);

    return `$${params.length}${type ?? ''}`;
  });

  return prisma.client.$executeRawUnsafe(query, ...params);
}

async function upsertHeatmapReplayPreviews({
  websiteId,
  sessionId,
  visitId,
  chunkIndex,
  events,
}: Pick<SaveRecordingArgs, 'websiteId' | 'sessionId' | 'visitId' | 'chunkIndex' | 'events'>) {
  const previewRows = extractHeatmapReplayPreviewRows({
    websiteId,
    sessionId,
    visitId,
    chunkIndex,
    events,
  });

  for (const row of previewRows) {
    await rawExecute(
      `
      insert into heatmap_replay_preview (
        preview_id,
        website_id,
        session_id,
        visit_id,
        url_path,
        viewport_w,
        viewport_h,
        replay_chunk_index,
        replay_event_index,
        replay_time_ms
      )
      values (
        {{id::uuid}},
        {{websiteId::uuid}},
        {{sessionId::uuid}},
        {{visitId::uuid}},
        {{urlPath}},
        {{viewportW}},
        {{viewportH}},
        {{replayChunkIndex}},
        {{replayEventIndex}},
        {{replayTimeMs::bigint}}
      )
      on conflict (website_id, url_path, viewport_w, viewport_h)
      do update set
        session_id = excluded.session_id,
        visit_id = excluded.visit_id,
        replay_chunk_index = excluded.replay_chunk_index,
        replay_event_index = excluded.replay_event_index,
        replay_time_ms = excluded.replay_time_ms,
        updated_at = now()
      `,
      {
        id: uuid(),
        websiteId: row.websiteId,
        sessionId: row.sessionId,
        visitId: row.visitId,
        urlPath: row.urlPath,
        viewportW: row.viewportW,
        viewportH: row.viewportH,
        replayChunkIndex: row.replayChunkIndex,
        replayEventIndex: row.replayEventIndex,
        replayTimeMs: toBigIntOrNull(row.replayTimeMs),
      },
    );
  }
}
