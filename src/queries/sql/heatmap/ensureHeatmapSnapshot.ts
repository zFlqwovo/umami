import prisma from '@/lib/prisma';
import { uuid } from '@/lib/crypto';
import { getWebsite } from '@/queries/prisma';

const SNAPSHOT_STATUS = {
  pending: 'pending',
  ready: 'ready',
  failed: 'failed',
} as const;

const SNAPSHOT_RETRY_DELAY_MS = 15 * 60 * 1000;
const SNAPSHOT_PENDING_WINDOW_MS = 30 * 1000;

export type HeatmapSnapshotStatus = (typeof SNAPSHOT_STATUS)[keyof typeof SNAPSHOT_STATUS];

export interface HeatmapSnapshotImage {
  id: string;
  imageUrl: string | null;
  status: HeatmapSnapshotStatus;
  mimeType: string | null;
  pageW: number;
  pageH: number;
  viewportW: number;
  viewportH: number;
  error: string | null;
}

interface SnapshotRecord {
  id: string;
  websiteId: string;
  urlPath: string;
  viewportW: number;
  viewportH: number;
  pageW: number;
  pageH: number;
  status: HeatmapSnapshotStatus;
  mimeType: string | null;
  imageSize: number | null;
  error: string | null;
  hasImage: boolean;
  updatedAt: Date | string | null;
}

interface EnsureHeatmapSnapshotOptions {
  websiteId: string;
  urlPath: string;
  viewportW: number | null;
  viewportH: number | null;
  pageW: number | null;
  pageH: number | null;
}

interface CaptureResult {
  imageData: Buffer;
  mimeType: string;
  pageW: number;
  pageH: number;
}

async function measurePage(page: any) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const root = document.scrollingElement || doc || body;
    let maxRight = 0;
    let maxBottom = 0;

    if (body) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode as Element | null;

      while (node) {
        const rect = node.getBoundingClientRect?.();

        if (rect && (rect.width > 0 || rect.height > 0)) {
          maxRight = Math.max(maxRight, rect.right);
          maxBottom = Math.max(maxBottom, rect.bottom);
        }

        node = walker.nextNode() as Element | null;
      }
    }

    const pageW = Math.max(
      window.innerWidth,
      root?.scrollWidth || 0,
      doc?.scrollWidth || 0,
      body?.scrollWidth || 0,
      Math.ceil(maxRight),
    );
    const pageH = Math.max(
      window.innerHeight,
      root?.scrollHeight || 0,
      doc?.scrollHeight || 0,
      body?.scrollHeight || 0,
      Math.ceil(maxBottom),
    );

    return {
      pageW: Math.ceil(pageW),
      pageH: Math.ceil(pageH),
    };
  });
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

async function findSnapshot(
  websiteId: string,
  urlPath: string,
  viewportW: number,
  viewportH: number,
): Promise<SnapshotRecord | null> {
  const rows = await prisma.rawQuery(
    `
    select
      snapshot_id as id,
      website_id as "websiteId",
      url_path as "urlPath",
      viewport_w as "viewportW",
      viewport_h as "viewportH",
      page_w as "pageW",
      page_h as "pageH",
      status,
      mime_type as "mimeType",
      image_size as "imageSize",
      error,
      image_data is not null as "hasImage",
      updated_at as "updatedAt"
    from heatmap_snapshot
    where website_id = {{websiteId::uuid}}
      and url_path = {{urlPath}}
      and viewport_w = {{viewportW}}
      and viewport_h = {{viewportH}}
    limit 1
    `,
    { websiteId, urlPath, viewportW, viewportH },
    'findHeatmapSnapshot',
  );

  return rows?.[0] ?? null;
}

function getSnapshotImageUrl(websiteId: string, snapshotId: string) {
  return `/api/websites/${websiteId}/heatmaps/snapshots/${snapshotId}`;
}

function mapSnapshot(websiteId: string, row: SnapshotRecord): HeatmapSnapshotImage {
  return {
    id: row.id,
    imageUrl: row.status === SNAPSHOT_STATUS.ready && row.hasImage ? getSnapshotImageUrl(websiteId, row.id) : null,
    status: row.status,
    mimeType: row.mimeType,
    pageW: Number(row.pageW),
    pageH: Number(row.pageH),
    viewportW: Number(row.viewportW),
    viewportH: Number(row.viewportH),
    error: row.error,
  };
}

function getFirstDomain(domain?: string | null) {
  return domain?.split(',')[0]?.trim() || null;
}

function getWebsiteOrigin(domain?: string | null) {
  const host = getFirstDomain(domain);

  if (!host) {
    return null;
  }

  if (host.startsWith('http://') || host.startsWith('https://')) {
    return new URL(host);
  }

  const protocol =
    host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]')
      ? 'http'
      : 'https';

  return new URL(`${protocol}://${host}`);
}

function buildCaptureUrl(domain: string | null | undefined, urlPath: string) {
  const origin = getWebsiteOrigin(domain);

  if (!origin) {
    return null;
  }

  return new URL(urlPath || '/', origin).toString();
}

export function shouldSkipSnapshot(urlPath: string) {
  // Internal Umami app routes cannot be rendered from the tracked website domain.
  return urlPath.startsWith('/teams/');
}

async function upsertSnapshotRecord({
  id,
  websiteId,
  urlPath,
  viewportW,
  viewportH,
  pageW,
  pageH,
  status,
  mimeType,
  imageData,
  error,
}: {
  id: string;
  websiteId: string;
  urlPath: string;
  viewportW: number;
  viewportH: number;
  pageW: number;
  pageH: number;
  status: HeatmapSnapshotStatus;
  mimeType: string | null;
  imageData: Buffer | null;
  error: string | null;
}) {
  return rawExecute(
    `
    insert into heatmap_snapshot (
      snapshot_id,
      website_id,
      url_path,
      viewport_w,
      viewport_h,
      page_w,
      page_h,
      status,
      mime_type,
      image_data,
      image_size,
      error,
      created_at,
      updated_at
    )
    values (
      {{id::uuid}},
      {{websiteId::uuid}},
      {{urlPath}},
      {{viewportW}},
      {{viewportH}},
      {{pageW}},
      {{pageH}},
      {{status}},
      {{mimeType}},
      {{imageData}},
      {{imageSize}},
      {{error}},
      now(),
      now()
    )
    on conflict (website_id, url_path, viewport_w, viewport_h) do update
    set
      page_w = excluded.page_w,
      page_h = excluded.page_h,
      status = excluded.status,
      mime_type = excluded.mime_type,
      image_data = excluded.image_data,
      image_size = excluded.image_size,
      error = excluded.error,
      updated_at = now()
    `,
    {
      id,
      websiteId,
      urlPath,
      viewportW,
      viewportH,
      pageW,
      pageH,
      status,
      mimeType,
      imageData,
      imageSize: imageData?.byteLength ?? null,
      error,
    },
  );
}

async function captureSnapshot(
  url: string,
  viewportW: number,
  viewportH: number,
  pageW?: number,
): Promise<CaptureResult> {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const initialViewportW = Math.max(viewportW, pageW || 0);

  try {
    const context = await browser.newContext({
      viewport: { width: initialViewportW, height: viewportH },
      screen: { width: initialViewportW, height: viewportH },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(500);

    let dimensions = await measurePage(page);
    let currentWidth = initialViewportW;
    let captureWidth = Math.max(initialViewportW, dimensions.pageW);

    for (let i = 0; i < 3; i++) {
      if (captureWidth <= currentWidth) {
        break;
      }

      currentWidth = captureWidth;

      await page.setViewportSize({
        width: currentWidth,
        height: viewportH,
      });
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(300);

      dimensions = await measurePage(page);
      captureWidth = Math.max(currentWidth, dimensions.pageW);
    }

    const imageData = Buffer.from(await page.screenshot({ fullPage: true, type: 'png' }));

    await context.close();

    return {
      imageData,
      mimeType: 'image/png',
      pageW: dimensions.pageW,
      pageH: dimensions.pageH,
    };
  } finally {
    await browser.close();
  }
}

export async function ensureHeatmapSnapshot({
  websiteId,
  urlPath,
  viewportW,
  viewportH,
  pageW,
  pageH,
}: EnsureHeatmapSnapshotOptions): Promise<HeatmapSnapshotImage | null> {
  if (!urlPath || !viewportW || !viewportH || !pageW || !pageH) {
    return null;
  }

  if (shouldSkipSnapshot(urlPath)) {
    return null;
  }

  const existing = await findSnapshot(websiteId, urlPath, viewportW, viewportH);

  if (existing?.status === SNAPSHOT_STATUS.ready && existing.hasImage) {
    return mapSnapshot(websiteId, existing);
  }

  const updatedAt = existing?.updatedAt ? new Date(existing.updatedAt) : null;
  const ageMs = updatedAt ? Date.now() - updatedAt.getTime() : Number.POSITIVE_INFINITY;

  if (
    existing?.status === SNAPSHOT_STATUS.pending &&
    ageMs < SNAPSHOT_PENDING_WINDOW_MS
  ) {
    return mapSnapshot(websiteId, existing);
  }

  if (
    existing?.status === SNAPSHOT_STATUS.failed &&
    ageMs < SNAPSHOT_RETRY_DELAY_MS
  ) {
    return mapSnapshot(websiteId, existing);
  }

  const snapshotId = existing?.id ?? uuid();
  const website = await getWebsite(websiteId);
  const captureUrl = buildCaptureUrl(website?.domain, urlPath);

  if (!captureUrl) {
    await upsertSnapshotRecord({
      id: snapshotId,
      websiteId,
      urlPath,
      viewportW,
      viewportH,
      pageW,
      pageH,
      status: SNAPSHOT_STATUS.failed,
      mimeType: null,
      imageData: null,
      error: 'Website domain is not configured for screenshot capture.',
    });

    const failed = await findSnapshot(websiteId, urlPath, viewportW, viewportH);

    return failed ? mapSnapshot(websiteId, failed) : null;
  }

  await upsertSnapshotRecord({
    id: snapshotId,
    websiteId,
    urlPath,
    viewportW,
    viewportH,
    pageW,
    pageH,
    status: SNAPSHOT_STATUS.pending,
    mimeType: null,
    imageData: null,
    error: null,
  });

  try {
    const capture = await captureSnapshot(captureUrl, viewportW, viewportH, pageW);

    await upsertSnapshotRecord({
      id: snapshotId,
      websiteId,
      urlPath,
      viewportW,
      viewportH,
      pageW: capture.pageW,
      pageH: capture.pageH,
      status: SNAPSHOT_STATUS.ready,
      mimeType: capture.mimeType,
      imageData: capture.imageData,
      error: null,
    });
  } catch (error) {
    await upsertSnapshotRecord({
      id: snapshotId,
      websiteId,
      urlPath,
      viewportW,
      viewportH,
      pageW,
      pageH,
      status: SNAPSHOT_STATUS.failed,
      mimeType: null,
      imageData: null,
      error: error instanceof Error ? error.message.slice(0, 500) : 'Screenshot capture failed.',
    });
  }

  const snapshot = await findSnapshot(websiteId, urlPath, viewportW, viewportH);

  return snapshot ? mapSnapshot(websiteId, snapshot) : null;
}

export async function getHeatmapSnapshotImage(
  websiteId: string,
  snapshotId: string,
): Promise<{ mimeType: string; imageData: Buffer } | null> {
  const rows = await prisma.rawQuery(
    `
    select
      mime_type as "mimeType",
      image_data as "imageData"
    from heatmap_snapshot
    where snapshot_id = {{snapshotId::uuid}}
      and website_id = {{websiteId::uuid}}
      and status = 'ready'
      and image_data is not null
    limit 1
    `,
    { websiteId, snapshotId },
    'getHeatmapSnapshotImage',
  );

  const row = rows?.[0];

  if (!row?.imageData || !row?.mimeType) {
    return null;
  }

  return {
    mimeType: row.mimeType,
    imageData: Buffer.from(row.imageData),
  };
}
