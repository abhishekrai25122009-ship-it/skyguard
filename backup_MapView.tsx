import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref } from 'react';

import { PROTECTED_ZONE } from '../engine/scenarios';
import type { SimView } from '../engine/sim';
import type { TrackSnapshot } from '../engine/sim';
import { headingFromVel } from '../engine/math';
import { MAP_X_MAX, MAP_X_MIN, MAP_Y_MAX, MAP_Y_MIN } from '../lib/geo';

// Small typed radar interface used by the parent control strip.
export interface MapHandle {
  fitScene: () => void;
  locateSelected: () => void;
}

interface MapViewProps {
  view: SimView;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  showTrails: boolean;
  showForecasts: boolean;
  showLabels: boolean;
  ref?: Ref<MapHandle>;
}

interface ViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

interface Size {
  width: number;
  height: number;
}

const SCENE_PAD = 300;
const FIT_PAD = 60;
const LOCATE_HALF = 250;
const GRID_STEP = 1000;

const AIRCRAFT_PATH =
  'M16 2 L19 12 L29 20 L29 23 L19 19 L18 26 L22 29 L22 31 L16 29 L10 31 L10 29 L14 26 L13 19 L3 23 L3 20 L13 12 Z';

function sceneViewBox(): ViewBox {
  const minX = MAP_X_MIN - SCENE_PAD;
  const maxX = MAP_X_MAX + SCENE_PAD;
  const minY = -MAP_Y_MAX - SCENE_PAD;
  const maxY = -MAP_Y_MIN + SCENE_PAD;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

function fitViewBox(view: SimView): ViewBox {
  const zone = PROTECTED_ZONE;
  const radius = Math.max(zone.radius, zone.bufferRadius);
  let minX = zone.centre.x - radius;
  let maxX = zone.centre.x + radius;
  let minY = zone.centre.y - radius;
  let maxY = zone.centre.y + radius;

  for (const track of view.tracks) {
    const pos = trackPosition(track);
    if (!pos) continue;
    minX = Math.min(minX, pos.x - 20);
    maxX = Math.max(maxX, pos.x + 20);
    minY = Math.min(minY, pos.y - 20);
    maxY = Math.max(maxY, pos.y + 20);
  }

  const width = Math.max(maxX - minX + FIT_PAD * 2, 1);
  const height = Math.max(maxY - minY + FIT_PAD * 2, 1);
  return { minX: minX + FIT_PAD, minY: minY + FIT_PAD, width, height };
}

function locateViewBox(track: TrackSnapshot): ViewBox {
  const pos = trackPosition(track);
  if (!pos) return sceneViewBox();
  const half = LOCATE_HALF;
  return { minX: pos.x - half, minY: pos.y - half, width: half * 2, height: half * 2 };
}

// Display adapter: engine x is east, y is north; SVG y grows downward, so y is
// flipped here only. All rendering happens in this display space.
interface DisplayPos {
  x: number;
  y: number;
}

function trackPosition(track: TrackSnapshot): DisplayPos | null {
  const last = track.observations[track.observations.length - 1];
  const position = track.estPos ?? last;
  if (!position) return null;
  const x = position.x;
  const y = -position.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function displayPoints(
  points: ReadonlyArray<{ x: number; y: number }>,
): DisplayPos[] {
  const out: DisplayPos[] = [];
  for (const point of points) {
    const x = point.x;
    const y = -point.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x, y });
  }
  return out;
}

function headingOf(track: TrackSnapshot): number {
  const velocity = track.estVel;
  const heading = velocity
    ? headingFromVel(velocity.x, velocity.y)
    : track.heading;
  return Number.isFinite(heading) ? heading : 0;
}

export default function MapView({
  view,
  selectedId,
  onSelect,
  showTrails,
  showForecasts,
  showLabels,
  ref,
}: MapViewProps) {
  const [viewBox, setViewBox] = useState<ViewBox>(() => sceneViewBox());
  const [size, setSize] = useState<Size>({ width: 800, height: 600 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () =>
      setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => update();
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const handleFitScene = useCallback(() => {
    setViewBox(fitViewBox(view));
  }, [view]);

  const handleLocateSelected = useCallback(() => {
    const track = view.tracks.find((t) => t.id === selectedId) ?? null;
    if (!track) return;
    const box = locateViewBox(track);
    setViewBox(box);
  }, [view, selectedId]);

  useImperativeHandle(
    ref,
    () => ({
      fitScene: () => {
        setViewBox(fitViewBox(view));
      },
      locateSelected: () => {
        const track = view.tracks.find((t) => t.id === selectedId) ?? null;
        if (!track) return;
        setViewBox(locateViewBox(track));
      },
    }),
    [view, selectedId],
  );

  const box = viewBox;
  const scale = Math.min(size.width / box.width, size.height / box.height);
  const pxMinX = box.minX * scale;
  const pxMinY = box.minY * scale;
  const pxW = box.width * scale;
  const pxH = box.height * scale;
  const px = (m: { x: number; y: number }) => ({
    x: (m.x - box.minX) * scale,
    y: (m.y - box.minY) * scale,
  });

  const gridLines: Array<{ x?: number; y?: number }> = [];
  const firstGridX = Math.ceil(box.minX / GRID_STEP) * GRID_STEP;
  for (let x = firstGridX; x < box.minX + box.width; x += GRID_STEP) {
    gridLines.push({ x });
  }
  const firstGridY = Math.ceil(box.minY / GRID_STEP) * GRID_STEP;
  for (let y = firstGridY; y < box.minY + box.height; y += GRID_STEP) {
    gridLines.push({ y });
  }

  const zone = PROTECTED_ZONE;
  const zoneCentre = px({ x: zone.centre.x, y: zone.centre.y });
  const zoneRadius = zone.radius * scale;
  const zoneBufferRadius = zone.bufferRadius * scale;

  return (
    <section
      aria-label="GARUD airspace map"
      style={{
        width: '100%',
        minWidth: 0,
        position: 'relative',
        border: '1px solid #263B2E',
        borderRadius: 8,
        overflow: 'hidden',
        background: '#09120E',
      }}
    >
      <style>{`
        .garud-map-button {
          background: #15251B;
          color: #E3EFE5;
          border: 1px solid #3D5A45;
          border-radius: 4px;
          padding: 7px 12px;
          cursor: pointer;
        }
        .garud-map-button:disabled {
          opacity: 0.45;
          cursor: default;
        }
        .garud-map-button:focus-visible {
          outline: 2px solid #9BEC70;
          outline-offset: 2px;
        }
      `}</style>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 10,
          padding: '10px 12px',
          color: '#E3EFE5',
        }}
      >
        <strong>AIRSPACE / SIMULATION</strong>

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="garud-map-button" onClick={handleFitScene}>
            Fit scene
          </button>
          <button
            type="button"
            className="garud-map-button"
            onClick={handleLocateSelected}
            disabled={!selectedId}
          >
            Locate selected
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: 'clamp(340px, 62vh, 720px)',
          minHeight: 340,
          backgroundColor: '#09120E',
        }}
      >
        <svg
          viewBox={`${pxMinX} ${pxMinY} ${pxW} ${pxH}`}
          width="100%"
          height="100%"
          style={{ display: 'block', width: '100%', height: '100%' }}
        >
          {gridLines.map((line, index) =>
            line.x === undefined ? (
              <line
                key={`gy-${index}`}
                x1={pxMinX}
                x2={pxMinX + pxW}
                y1={px({ x: box.minX, y: line.y ?? 0 }).y}
                y2={px({ x: box.minX, y: line.y ?? 0 }).y}
                stroke="#14241A"
                strokeWidth={1}
              />
            ) : (
              <line
                key={`gx-${index}`}
                x1={px({ x: line.x, y: box.minY }).x}
                x2={px({ x: line.x, y: box.minY }).x}
                y1={pxMinY}
                y2={pxMinY + pxH}
                stroke="#14241A"
                strokeWidth={1}
              />
            ),
          )}

          <g transform={`translate(${pxMinX + pxW / 2} ${pxMinY + 18})`}>
            <path d="M0 0 L-7 -10 L7 -10 Z" fill="#9BEC70" />
            <text
              x={0}
              y={-12}
              textAnchor="middle"
              fontSize={12}
              fontWeight={700}
              fill="#9BEC70"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
            >
              N
            </text>
          </g>

          <circle
            cx={zoneCentre.x}
            cy={zoneCentre.y}
            r={zoneRadius}
            fill="#74D5E8"
            fillOpacity={0.06}
            stroke="#74D5E8"
            strokeWidth={Math.max(1, 2 * scale)}
          />
          <circle
            cx={zoneCentre.x}
            cy={zoneCentre.y}
            r={zoneBufferRadius}
            fill="none"
            stroke="#F4BA56"
            strokeWidth={Math.max(1, scale)}
            strokeDasharray="8 6"
            opacity={0.7}
          />
          <text
            x={zoneCentre.x}
            y={zoneCentre.y - zoneRadius - 14}
            textAnchor="middle"
            fontSize={12}
            fill="#74D5E8"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
          >
            {`${zone.name} · ${zone.floor}–${zone.ceiling} m`}
          </text>

          {view.tracks.map((track) => {
            const position = trackPosition(track);
            if (!position) return null;

            const points = displayPoints(track.observations.slice(-160)).map(
              (p) => px(p),
            );
            const showTrail = showTrails && points.length > 1;
            const forecastPoints =
              showForecasts &&
              selectedId === track.id &&
              track.forecastState === 'ready'
                ? [position, ...displayPoints(track.forecast)]
                : [];
            const showForecast =
              showForecasts &&
              selectedId === track.id &&
              track.forecastState === 'ready';
            const forecastPathPoints = showForecast
              ? forecastPoints
                  .map((p) => px(p))
                  .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
              : [];

            const heading = headingOf(track);
            const selected = track.id === selectedId;
            const lost = track.freshness === 'lost';
            const stale = track.freshness === 'stale';
            const fillColor =
              lost
                ? '#A2B5A6'
                : track.auth === 'authorized'
                  ? '#9BEC70'
                  : track.inZone
                    ? '#FF756B'
                    : '#F4BA56';
            const strokeColor = selected
              ? '#9BEC70'
              : stale
                ? '#F4BA56'
                : lost
                  ? '#A2B5A6'
                  : fillColor;

            const markerX = px(position).x;
            const markerY = px(position).y;

            const label = selected
              ? `${track.callsign} · ${track.freshness} · age ${track.age.toFixed(0)}s`
              : track.callsign;

            return (
              <g key={track.id}>
                {showTrail && (
                  <polyline
                    points={points.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="none"
                    stroke="#7B9F8B"
                    strokeWidth={2}
                    opacity={0.65}
                  />
                )}
                {showForecast && forecastPathPoints.length > 0 && (
                  <polyline
                    points={forecastPathPoints
                      .map((p) => `${p.x},${p.y}`)
                      .join(' ')}
                    fill="none"
                    stroke="#74D5E8"
                    strokeWidth={2.5}
                    strokeDasharray="8 6"
                    opacity={0.9}
                  />
                )}

                <g
                  transform={`translate(${markerX} ${markerY}) rotate(${heading} 16 16)`}
                  onClick={() => onSelect(track.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(track.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  style={{ cursor: 'pointer' }}
                >
                  {selected && (
                    <circle
                      cx={16}
                      cy={16}
                      r={18}
                      fill="none"
                      stroke="#9BEC70"
                      strokeOpacity={0.55}
                      strokeWidth={1.5}
                    />
                  )}
                  <path
                    d={AIRCRAFT_PATH}
                    fill={lost ? '#A2B5A6' : fillColor}
                    fillOpacity={lost ? 0.55 : 1}
                    stroke={strokeColor}
                    strokeWidth={selected ? 3 : 1.5}
                    strokeDasharray={stale ? '5 4' : undefined}
                    strokeLinejoin="round"
                  />
                </g>

                {showLabels && (
                  <text
                    x={markerX}
                    y={markerY - 16}
                    textAnchor="middle"
                    fontSize={12}
                    fill={selected ? '#9BEC70' : '#E3EFE5'}
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
                  >
                    {label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          padding: '10px 12px',
          fontSize: 12,
          color: '#A2B5A6',
        }}
      >
        <span>Solid line: observed trail</span>
        <span style={{ color: '#74D5E8' }}>Dashed path: forecast</span>
        <span style={{ color: '#F4BA56' }}>Amber ring: configured buffer</span>
        <span>Local schematic · Synthetic tracks</span>
      </div>
    </section>
  );
}
