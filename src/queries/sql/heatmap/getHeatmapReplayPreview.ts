import prisma from '@/lib/prisma';

export interface HeatmapReplayPreview {
  id: string;
  replayId: string;
  chunkIndex: number;
  eventIndex: number;
  replayTimeMs: number | null;
  viewportW: number;
  viewportH: number;
}

export async function getHeatmapReplayPreview(
  websiteId: string,
  urlPath: string,
  viewportW: number | null,
  viewportH: number | null,
): Promise<HeatmapReplayPreview | null> {
  if (!websiteId || !urlPath || !viewportW || !viewportH) {
    return null;
  }

  const rows: {
    id: string;
    replayId: string;
    chunkIndex: number;
    eventIndex: number;
    replayTimeMs: bigint | number | null;
    viewportW: number;
    viewportH: number;
  }[] = await prisma.rawQuery(
    `
    select
      preview_id as id,
      visit_id as "replayId",
      replay_chunk_index as "chunkIndex",
      replay_event_index as "eventIndex",
      replay_time_ms as "replayTimeMs",
      viewport_w as "viewportW",
      viewport_h as "viewportH"
    from heatmap_replay_preview
    where website_id = {{websiteId::uuid}}
      and url_path = {{urlPath}}
      and viewport_w = {{viewportW}}
      and viewport_h = {{viewportH}}
    limit 1
    `,
    { websiteId, urlPath, viewportW, viewportH },
    'getHeatmapReplayPreview',
  );

  if (!rows.length) {
    return null;
  }

  const row = rows[0];

  return {
    id: row.id,
    replayId: row.replayId,
    chunkIndex: Number(row.chunkIndex),
    eventIndex: Number(row.eventIndex),
    replayTimeMs:
      row.replayTimeMs === null || row.replayTimeMs === undefined
        ? null
        : Number(row.replayTimeMs),
    viewportW: Number(row.viewportW),
    viewportH: Number(row.viewportH),
  };
}
