'use client';
import {
  Column,
  Grid,
  Heading,
  Icon,
  ListItem,
  Loading,
  Row,
  Select,
  Text,
} from '@umami/react-zen';
import { Laptop, Monitor, Smartphone, Tablet } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { useResultQuery } from '@/components/hooks';
import { getClientAuthToken } from '@/lib/client';
import { formatLongNumber } from '@/lib/format';
import type { HeatmapMode, HeatmapPoint, HeatmapResult, HeatmapSnapshot } from '@/queries/sql';
import styles from './Heatmap.module.css';

const CLICK_EDGE_PERCENT = 1.5;
const SCROLL_BUCKET_SIZE = 10;
const CANVAS_MAX_HEIGHT_RATIO = 0.75;
const SCREEN_WIDTH_BUCKETS = [320, 375, 425, 768, 1024, 1440, 1920] as const;

interface ScreenWidthBucket {
  width: number;
  viewportH: number;
  pageW: number;
  pageH: number;
  positions: number;
  clicks: number;
  minViewportW: number;
  maxViewportW: number;
}

interface HeatmapProps {
  websiteId: string;
  urlPath: string;
  onUrlPathChange: (urlPath: string) => void;
  mode: HeatmapMode;
  search: string;
}

export function Heatmap({ websiteId, urlPath, onUrlPathChange, mode, search }: HeatmapProps) {
  const {
    data: pagesData,
    error,
    isLoading,
  } = useResultQuery<HeatmapResult>('heatmap', {
    websiteId,
    mode,
  });

  const {
    data: detailData,
    isLoading: isDetailLoading,
    isFetching: isDetailFetching,
  } = useResultQuery<HeatmapResult>(
    'heatmap',
    {
      websiteId,
      urlPath: urlPath || undefined,
      mode,
    },
    {
      enabled: Boolean(urlPath),
    },
  );

  const pages = pagesData?.pages ?? [];
  const filteredPages = useMemo(() => {
    if (!search) {
      return pages;
    }

    const value = search.toLowerCase();

    return pages.filter(page => page.urlPath.toLowerCase().includes(value));
  }, [pages, search]);
  const points = detailData?.points ?? [];
  const scroll = detailData?.scroll;
  const snapshot = detailData?.snapshot ?? null;
  const detailLoading = Boolean(urlPath) && (isDetailLoading || isDetailFetching);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (filteredPages.length === 0) {
      if (urlPath) {
        onUrlPathChange('');
      }
      return;
    }

    if (!urlPath || filteredPages.some(page => page.urlPath === urlPath)) {
      return;
    }

    onUrlPathChange(filteredPages[0].urlPath);
  }, [filteredPages, isLoading, onUrlPathChange, urlPath]);

  if (!isLoading && pages.length === 0) {
    return (
      <LoadingPanel data={pagesData} isLoading={isLoading} error={error} minHeight="900px">
        <EmptyState message="No data available." />
      </LoadingPanel>
    );
  }

  return (
    <LoadingPanel data={pagesData} isLoading={isLoading} error={error} minHeight="900px">
      <Grid columns="320px 12px 1fr" minHeight="900px" className={styles.layoutGrid}>
        <PageList
          pages={filteredPages}
          selected={urlPath}
          onSelect={onUrlPathChange}
          mode={mode}
          hasSearch={Boolean(search)}
        />
        <div className={styles.railDivider} aria-hidden="true" />
        <Column className={styles.contentColumn} gap>
          {urlPath ? (
            mode === 'scroll' ? (
              <ScrollHeatmapView
                urlPath={urlPath}
                scroll={scroll}
                snapshot={snapshot}
                isLoading={detailLoading}
              />
            ) : (
              <ClickHeatmapView
                urlPath={urlPath}
                points={points}
                snapshot={snapshot}
                isLoading={detailLoading}
              />
            )
          ) : (
            <EmptyState />
          )}
        </Column>
      </Grid>
    </LoadingPanel>
  );
}

function PageList({
  pages,
  selected,
  onSelect,
  mode,
  hasSearch,
}: {
  pages: HeatmapResult['pages'];
  selected: string;
  onSelect: (urlPath: string) => void;
  mode: HeatmapMode;
  hasSearch: boolean;
}) {
  const getPageMetricTitle = (page: HeatmapResult['pages'][number]) => {
    const metricLabel = mode === 'scroll' ? 'scroll events' : 'clicks';

    return `${formatLongNumber(page.sessions)} visitors - ${formatLongNumber(page.count)} ${metricLabel}`;
  };

  return (
    <Column className={styles.pageList} gap="1">
      <Heading size="lg">Pages</Heading>
      <Column className={styles.pageListItems} gap="2">
        {pages.length === 0 && hasSearch && <Text color="muted">No matching pages</Text>}
        {pages.map(page => (
          <button
            key={page.urlPath}
            type="button"
            onClick={() => onSelect(page.urlPath)}
            title={page.urlPath}
            className={`${styles.pageButton} ${selected === page.urlPath ? styles.pageButtonSelected : ''}`}
          >
            <Row alignItems="center" justifyContent="space-between" gap="2">
              <Text truncate>{page.urlPath}</Text>
              <Text color="muted" className={styles.pageMetric} title={getPageMetricTitle(page)}>
                {formatLongNumber(page.sessions)}
              </Text>
            </Row>
          </button>
        ))}
      </Column>
    </Column>
  );
}

function getScreenWidthBucketWidth(viewportW: number) {
  return SCREEN_WIDTH_BUCKETS.reduce((best, width) => {
    const bestDistance = Math.abs(viewportW - best);
    const distance = Math.abs(viewportW - width);

    return distance < bestDistance ? width : best;
  }, SCREEN_WIDTH_BUCKETS[0]);
}

function getScreenWidthBuckets(points: HeatmapPoint[]): ScreenWidthBucket[] {
  if (!points.length) {
    return [];
  }

  const buckets = new Map<
    number,
    ScreenWidthBucket & {
      weightedViewportH: number;
    }
  >();

  for (const point of points) {
    const width = getScreenWidthBucketWidth(point.viewportW);
    const scale = width / Math.max(1, point.viewportW);
    const scaledViewportH = point.viewportH * scale;
    const scaledPageW = Math.max(width, point.pageW * scale);
    const scaledPageH = Math.max(scaledViewportH, point.pageH * scale);
    const existing = buckets.get(width);

    if (existing) {
      existing.positions += 1;
      existing.clicks += point.count;
      existing.pageW = Math.max(existing.pageW, scaledPageW);
      existing.pageH = Math.max(existing.pageH, scaledPageH);
      existing.weightedViewportH += scaledViewportH * point.count;
      existing.minViewportW = Math.min(existing.minViewportW, point.viewportW);
      existing.maxViewportW = Math.max(existing.maxViewportW, point.viewportW);
      continue;
    }

    buckets.set(width, {
      width,
      viewportH: scaledViewportH,
      pageW: scaledPageW,
      pageH: scaledPageH,
      positions: 1,
      clicks: point.count,
      minViewportW: point.viewportW,
      maxViewportW: point.viewportW,
      weightedViewportH: scaledViewportH * point.count,
    });
  }

  return SCREEN_WIDTH_BUCKETS.map(width => buckets.get(width))
    .filter((bucket): bucket is ScreenWidthBucket & { weightedViewportH: number } =>
      Boolean(bucket),
    )
    .map(({ weightedViewportH, ...bucket }) => ({
      ...bucket,
      viewportH: Math.max(1, Math.round(weightedViewportH / Math.max(1, bucket.clicks))),
      pageW: Math.max(bucket.width, Math.round(bucket.pageW)),
      pageH: Math.max(640, Math.round(bucket.pageH)),
    }));
}

function getDefaultScreenWidthBucket(buckets: ScreenWidthBucket[]) {
  return buckets.reduce<ScreenWidthBucket | null>(
    (best, bucket) => (!best || bucket.clicks > best.clicks ? bucket : best),
    null,
  );
}

function normalizePointToBucket(point: HeatmapPoint, bucket: ScreenWidthBucket): HeatmapPoint {
  const scale = bucket.width / Math.max(1, point.viewportW);
  const viewportH = Math.max(1, Math.round(point.viewportH * scale));

  return {
    ...point,
    x: point.x * scale,
    y: point.y * scale,
    pageX: point.pageX * scale,
    pageY: point.pageY * scale,
    pageW: Math.max(bucket.width, point.pageW * scale),
    pageH: Math.max(viewportH, point.pageH * scale),
    viewportW: bucket.width,
    viewportH,
  };
}

function getNormalizedBucketPoints(points: HeatmapPoint[], bucket: ScreenWidthBucket) {
  const groupedPoints = new Map<string, HeatmapPoint>();

  for (const point of points) {
    if (getScreenWidthBucketWidth(point.viewportW) !== bucket.width) {
      continue;
    }

    const normalized = normalizePointToBucket(point, bucket);
    const pageX = Math.round(normalized.pageX);
    const pageY = Math.round(normalized.pageY);
    const key = `${pageX}:${pageY}`;
    const existing = groupedPoints.get(key);

    if (existing) {
      existing.count += normalized.count;
      existing.pageW = Math.max(existing.pageW, normalized.pageW);
      existing.pageH = Math.max(existing.pageH, normalized.pageH);
      continue;
    }

    groupedPoints.set(key, {
      ...normalized,
      x: Math.round(normalized.x),
      y: Math.round(normalized.y),
      pageX,
      pageY,
    });
  }

  return Array.from(groupedPoints.values());
}

function useCanvasFit(renderWidth: number, renderHeight: number) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const updateAvailableSize = () => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      const width = rect?.width ?? 0;
      const height = window.innerHeight * CANVAS_MAX_HEIGHT_RATIO;

      setAvailable(current =>
        current.width === width && current.height === height ? current : { width, height },
      );
    };

    updateAvailableSize();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateAvailableSize) : null;

    if (wrapperRef.current && resizeObserver) {
      resizeObserver.observe(wrapperRef.current);
    }

    window.addEventListener('resize', updateAvailableSize);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateAvailableSize);
    };
  }, []);

  const safeWidth = Math.max(1, renderWidth);
  const safeHeight = Math.max(1, renderHeight);
  const scale =
    available.width && available.height
      ? Math.min(1, available.width / safeWidth, available.height / safeHeight)
      : 1;

  return {
    wrapperRef,
    scale,
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

function ScreenWidthSelect({
  buckets,
  value,
  onChange,
}: {
  buckets: ScreenWidthBucket[];
  value: number | null;
  onChange: (value: number) => void;
}) {
  const bucketsByWidth = useMemo(
    () => new Map(buckets.map(bucket => [bucket.width, bucket])),
    [buckets],
  );

  if (!value || buckets.length === 0) {
    return null;
  }

  return (
    <Row alignItems="center" gap="2" className={styles.screenWidthControl}>
      <Text color="muted" className={styles.screenWidthLabel}>
        Screen width:
      </Text>
      <Select
        aria-label="Screen width"
        value={value}
        onChange={nextValue => onChange(Number(nextValue))}
        maxHeight={420}
        renderValue={() => <ScreenWidthValue width={value} />}
        buttonProps={{
          style: {
            minHeight: 36,
            minWidth: 132,
          },
        }}
        listProps={{
          style: {
            width: 176,
          },
        }}
      >
        {SCREEN_WIDTH_BUCKETS.map(width => {
          const bucket = bucketsByWidth.get(width);

          return (
            <ListItem key={width} id={width} isDisabled={!bucket}>
              <Row alignItems="center" justifyContent="space-between" gap="2">
                <ScreenWidthValue width={width} />
                {bucket && (
                  <Text color="muted" className={styles.screenWidthCount}>
                    {formatLongNumber(bucket.clicks)}
                  </Text>
                )}
              </Row>
            </ListItem>
          );
        })}
      </Select>
    </Row>
  );
}

function ScreenWidthValue({ width }: { width: number }) {
  return (
    <Row alignItems="center" gap="2" className={styles.screenWidthValue}>
      <ScreenWidthIcon width={width} />
      <Text>{width} px</Text>
    </Row>
  );
}

function ScreenWidthIcon({ width }: { width: number }) {
  const DeviceIcon =
    width < 768 ? Smartphone : width < 1200 ? Tablet : width < 1600 ? Laptop : Monitor;

  return (
    <Icon size="sm">
      <DeviceIcon />
    </Icon>
  );
}

function ClickHeatmapView({
  urlPath,
  points,
  snapshot,
  isLoading,
}: {
  urlPath: string;
  points: HeatmapPoint[];
  snapshot: HeatmapSnapshot | null;
  isLoading: boolean;
}) {
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [selectedScreenWidth, setSelectedScreenWidth] = useState<number | null>(null);
  const screenWidthBuckets = useMemo(() => getScreenWidthBuckets(points), [points]);
  const defaultScreenWidth = useMemo(
    () => getDefaultScreenWidthBucket(screenWidthBuckets)?.width ?? null,
    [screenWidthBuckets],
  );

  useEffect(() => {
    const availableWidths = new Set(screenWidthBuckets.map(bucket => bucket.width));

    setSelectedScreenWidth(current => {
      if (!defaultScreenWidth) {
        return null;
      }

      return current && availableWidths.has(current) ? current : defaultScreenWidth;
    });
  }, [defaultScreenWidth, screenWidthBuckets]);

  const viewport = useMemo(() => {
    const activeWidth = selectedScreenWidth ?? defaultScreenWidth;

    return screenWidthBuckets.find(bucket => bucket.width === activeWidth) ?? null;
  }, [defaultScreenWidth, screenWidthBuckets, selectedScreenWidth]);

  const visible = useMemo(() => {
    if (!viewport) {
      return [];
    }

    return getNormalizedBucketPoints(points, viewport);
  }, [points, viewport]);

  const maxCount = useMemo(
    () => visible.reduce((max, point) => (point.count > max ? point.count : max), 1),
    [visible],
  );

  const handleSnapshotReady = useCallback(() => setSnapshotReady(true), []);
  const hasSnapshot = Boolean(snapshot);

  useEffect(() => {
    setSnapshotReady(!hasSnapshot);
  }, [hasSnapshot, snapshot?.id]);
  const overlayGutter = Math.max(48, Math.round((viewport?.width ?? 1920) * 0.04));
  const maxPointX = visible.reduce((max, point) => Math.max(max, point.pageX), 0);
  const maxPointY = visible.reduce((max, point) => Math.max(max, point.pageY), 0);
  const baseWidth = Math.max(viewport?.pageW ?? 0, maxPointX + overlayGutter, 1);
  const baseHeight = Math.max(viewport?.pageH ?? 0, maxPointY + overlayGutter, 640);
  const renderWidth = viewport?.pageW ?? snapshot?.pageW ?? baseWidth;
  const renderHeight = viewport?.pageH ?? snapshot?.pageH ?? baseHeight;
  const hasMeasuredWidth = Boolean(snapshot?.pageW || viewport?.pageW || maxPointX);
  const fit = useCanvasFit(renderWidth, renderHeight);
  const canvasWidth = hasMeasuredWidth ? `${fit.width}px` : '100%';
  const canvasHeight = hasMeasuredWidth ? `${fit.height}px` : undefined;
  const overlayPageW = viewport?.pageW ?? snapshot?.pageW ?? baseWidth;
  const overlayPageH = viewport?.pageH ?? snapshot?.pageH ?? baseHeight;
  const shouldRenderSnapshot = renderWidth > 0 && hasSnapshot;
  const showOverlay = !shouldRenderSnapshot || snapshotReady;
  const totalClicks = visible.reduce((sum, point) => sum + point.count, 0);
  const bucketDescription = viewport
    ? viewport.minViewportW === viewport.maxViewportW
      ? `Recorded at ${viewport.minViewportW}px wide`
      : `Grouped recorded widths from ${viewport.minViewportW}px to ${viewport.maxViewportW}px`
    : undefined;
  const showLoading = isLoading;

  return (
    <Column gap>
      <Column gap="2" className={styles.summaryHeader}>
        <Row alignItems="center" justifyContent="space-between" gap>
          <Text color="muted" title={urlPath} className={styles.summaryPath}>
            {urlPath}
          </Text>
        </Row>
        {showLoading ? (
          <Row alignItems="center" gap className={styles.summaryStats}>
            <Text color="muted" className={styles.summaryStat}>
              Loading Heatmap...
            </Text>
          </Row>
        ) : (
          <Row
            alignItems="center"
            justifyContent="space-between"
            gap
            className={styles.summaryStats}
          >
            <Text color="muted" className={styles.summaryStat} title={bucketDescription}>
              {viewport
                ? `${visible.length} positions - ${formatLongNumber(totalClicks)} clicks - screen width ${viewport.width}px`
                : 'No click data for this page yet.'}
            </Text>
            <ScreenWidthSelect
              buckets={screenWidthBuckets}
              value={viewport?.width ?? null}
              onChange={setSelectedScreenWidth}
            />
          </Row>
        )}
      </Column>

      <div ref={fit.wrapperRef} className={styles.canvasWrapper}>
        <div
          className={styles.canvas}
          style={{
            width: canvasWidth,
            height: canvasHeight,
            aspectRatio: `${Math.max(1, renderWidth)} / ${Math.max(1, renderHeight)}`,
          }}
        >
          {showLoading ? (
            <CanvasLoading />
          ) : !viewport || visible.length === 0 ? (
            <EmptyState message="No click data for this page yet." />
          ) : (
            <div
              className={styles.canvasSurface}
              style={{
                width: Math.max(1, renderWidth),
                height: Math.max(1, renderHeight),
                transform: `scale(${fit.scale})`,
              }}
            >
              <div className={styles.snapshotClip}>
                {shouldRenderSnapshot && !snapshotReady && <CanvasLoading />}
                {shouldRenderSnapshot && snapshot && (
                  <SnapshotPreview snapshot={snapshot} onReady={handleSnapshotReady} />
                )}
              </div>
              {showOverlay && (
                <div className={styles.overlay}>
                  {visible.map((point, index) => {
                    const intensity = Math.min(1, point.count / maxCount);
                    const desiredSize = 24 + intensity * 36;
                    const rawCenterX = (point.pageX / Math.max(1, overlayPageW)) * 100;
                    const rawCenterY = (point.pageY / Math.max(1, overlayPageH)) * 100;
                    const size = desiredSize;
                    const centerX = Math.max(
                      CLICK_EDGE_PERCENT,
                      Math.min(100 - CLICK_EDGE_PERCENT, rawCenterX),
                    );
                    const centerY = Math.max(
                      CLICK_EDGE_PERCENT,
                      Math.min(100 - CLICK_EDGE_PERCENT, rawCenterY),
                    );

                    return (
                      <div
                        key={`${point.pageX}-${point.pageY}-${index}`}
                        className={styles.dot}
                        style={{
                          left: `${centerX}%`,
                          top: `${centerY}%`,
                          width: size,
                          height: size,
                          transform: 'translate(-50%, -50%)',
                          opacity: 0.25 + intensity * 0.55,
                        }}
                        title={`${point.count} click${point.count === 1 ? '' : 's'}`}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Column>
  );
}

function ScrollHeatmapView({
  urlPath,
  scroll,
  snapshot,
  isLoading,
}: {
  urlPath: string;
  scroll: HeatmapResult['scroll'] | undefined;
  snapshot: HeatmapSnapshot | null;
  isLoading: boolean;
}) {
  const [snapshotReady, setSnapshotReady] = useState(false);
  const handleSnapshotReady = useCallback(() => setSnapshotReady(true), []);
  const hasSnapshot = Boolean(snapshot);

  useEffect(() => {
    setSnapshotReady(!hasSnapshot);
  }, [hasSnapshot, snapshot?.id]);
  const {
    buckets = [],
    totalSessions = 0,
    pageW = 0,
    pageH = 0,
    viewportW = 0,
    viewportH = 0,
  } = scroll ?? {};
  const baseWidth = Math.max(pageW, 1);
  const baseHeight = Math.max(pageH, 640);
  const renderWidth = snapshot?.pageW ?? baseWidth;
  const renderHeight = snapshot?.pageH ?? baseHeight;
  const hasMeasuredWidth = Boolean(snapshot?.pageW || pageW);
  const fit = useCanvasFit(renderWidth, renderHeight);
  const canvasWidth = hasMeasuredWidth ? `${fit.width}px` : '100%';
  const canvasHeight = hasMeasuredWidth ? `${fit.height}px` : undefined;
  const shouldRenderSnapshot = renderWidth > 0 && hasSnapshot;
  const showOverlay = !shouldRenderSnapshot || snapshotReady;
  const hasScrollData = Boolean(scroll && totalSessions > 0 && pageW && pageH && viewportW);
  const showLoading = isLoading;

  type Band = { fromPct: number; toPct: number; reached: number; ratio: number };
  const bands: Band[] = [];
  const sessionsByDepth = new Map(buckets.map(bucket => [bucket.depth, bucket.sessions]));
  let dropped = 0;

  for (let depth = 0; depth < 100; depth += SCROLL_BUCKET_SIZE) {
    const reached = Math.max(0, totalSessions - dropped);
    dropped += sessionsByDepth.get(depth) ?? 0;
    const nextReached = Math.max(0, totalSessions - dropped);
    const ratio = totalSessions ? nextReached / totalSessions : 0;

    if (reached > 0) {
      bands.push({
        fromPct: depth,
        toPct: Math.min(100, depth + SCROLL_BUCKET_SIZE),
        reached: nextReached,
        ratio,
      });
    }
  }

  return (
    <Column gap>
      <Text color="muted" title={urlPath} className={styles.summaryPath}>
        {urlPath}
      </Text>
      {showLoading ? (
        <Row alignItems="center" gap className={styles.summaryStats}>
          <Text color="muted" className={styles.summaryStat}>
            Loading Heatmap...
          </Text>
        </Row>
      ) : (
        <Row
          alignItems="center"
          justifyContent="space-between"
          gap
          className={styles.summaryHeader}
        >
          <Text color="muted" className={styles.summaryStat}>
            {hasScrollData
              ? `${formatLongNumber(totalSessions)} sessions - page ${pageW}x${pageH}${viewportH ? ` - viewport ${viewportW}x${viewportH}` : ''}`
              : 'No scroll data for this page yet.'}
          </Text>
        </Row>
      )}

      <div ref={fit.wrapperRef} className={styles.canvasWrapper}>
        <div
          className={styles.canvas}
          style={{
            width: canvasWidth,
            height: canvasHeight,
            aspectRatio: `${Math.max(1, renderWidth)} / ${Math.max(1, renderHeight)}`,
          }}
        >
          {showLoading ? (
            <CanvasLoading />
          ) : !hasScrollData ? (
            <EmptyState message="No scroll data for this page yet." />
          ) : (
            <div
              className={styles.canvasSurface}
              style={{
                width: Math.max(1, renderWidth),
                height: Math.max(1, renderHeight),
                transform: `scale(${fit.scale})`,
              }}
            >
              {shouldRenderSnapshot && !snapshotReady && <CanvasLoading />}
              {shouldRenderSnapshot && snapshot && (
                <SnapshotPreview snapshot={snapshot} onReady={handleSnapshotReady} />
              )}
              {showOverlay && (
                <div className={styles.overlay}>
                  {bands.map(band => {
                    const intensity = band.ratio;
                    const hue = Math.round(60 - intensity * 60);

                    return (
                      <div
                        key={band.fromPct}
                        className={styles.scrollBand}
                        style={{
                          top: `${band.fromPct}%`,
                          height: `${Math.max(0, band.toPct - band.fromPct)}%`,
                          background:
                            intensity > 0
                              ? `hsla(${hue}, 90%, 55%, ${0.12 + intensity * 0.45})`
                              : 'none',
                        }}
                        title={`${band.toPct}% depth - ${formatLongNumber(band.reached)} sessions reached`}
                      >
                        <span className={styles.scrollBandLabel}>
                          {band.toPct}% depth - {Math.round(intensity * 100)}% reached
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Column>
  );
}

function SnapshotPreview({
  snapshot,
  onReady,
}: {
  snapshot: HeatmapSnapshot;
  onReady: () => void;
}) {
  if (snapshot.kind === 'iframe') {
    return <IframeSnapshot snapshot={snapshot} onReady={onReady} />;
  }

  return <SnapshotImage snapshot={snapshot} onReady={onReady} />;
}

function SnapshotImage({
  snapshot,
  onReady,
}: {
  snapshot: Extract<HeatmapSnapshot, { kind: 'image' }>;
  onReady: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const imageUrl = snapshot.imageUrl;

  useEffect(() => {
    if (!imageUrl) {
      setSrc(null);
      onReady();
      return;
    }

    const controller = new AbortController();
    const token = getClientAuthToken();
    let objectUrl: string | null = null;

    setSrc(null);

    fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
      .then(async response => {
        if (!response.ok) {
          throw new Error(`Snapshot image request failed: ${response.status}`);
        }

        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        setSrc(null);
        onReady();
      });

    return () => {
      controller.abort();

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [imageUrl, onReady, snapshot.id]);

  const handleLoad = useCallback(() => onReady(), [onReady]);

  return (
    <div className={styles.snapshot}>
      <img
        className={styles.snapshotImage}
        src={src || undefined}
        alt=""
        draggable={false}
        onLoad={handleLoad}
      />
    </div>
  );
}

function IframeSnapshot({
  snapshot,
  onReady,
}: {
  snapshot: Extract<HeatmapSnapshot, { kind: 'iframe' }>;
  onReady: () => void;
}) {
  const [available, setAvailable] = useState(true);
  const iframeUrl = snapshot.url;

  useEffect(() => {
    setAvailable(true);

    const readyTimer = window.setTimeout(() => onReady(), 1500);

    return () => window.clearTimeout(readyTimer);
  }, [onReady, snapshot.id]);

  const handleLoad = useCallback(() => onReady(), [onReady]);
  const handleError = useCallback(() => {
    setAvailable(false);
    onReady();
  }, [onReady]);

  if (!available) {
    return null;
  }

  return (
    <div className={styles.snapshot}>
      <iframe
        className={`${styles.snapshotIframe} rr-block`}
        src={iframeUrl}
        title={iframeUrl}
        tabIndex={-1}
        loading="lazy"
        referrerPolicy="no-referrer"
        onLoad={handleLoad}
        onError={handleError}
      />
    </div>
  );
}

function CanvasLoading() {
  return (
    <div className={styles.canvasLoading}>
      <Loading icon="dots" placement="center" />
    </div>
  );
}

function EmptyState({ message }: { message?: string } = {}) {
  return (
    <Column alignItems="center" justifyContent="center" minHeight="360px" gap>
      {!message && <Heading size="lg">Select a page</Heading>}
      <Text color="muted">{message ?? 'Choose a page from the list to view its heatmap.'}</Text>
    </Column>
  );
}
