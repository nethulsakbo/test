// src/app/api/compute-trace/route.ts
import { NextRequest, NextResponse } from 'next/server';
import {
  ComputedRaceTrace,
  OpenF1Driver,
  OpenF1LocationPoint,
  TelemetrySample,
} from '@/types/openf1';

const OPENF1_BASE = 'https://api.openf1.org/v1';

export async function GET(req: NextRequest) {
  const sessionKey = Number(req.nextUrl.searchParams.get('session_key'));
  const startParam = req.nextUrl.searchParams.get('date_start');
  const endParam = req.nextUrl.searchParams.get('date_end');

  if (!sessionKey) {
    return NextResponse.json({ error: 'Missing session_key' }, { status: 400 });
  }

  try {
    // 1. Fetch Drivers in Session
    const driversRes = await fetch(`${OPENF1_BASE}/drivers?session_key=${sessionKey}`, {
      next: { revalidate: 86400 },
    });
    const driversRaw: OpenF1Driver[] = await driversRes.json();
    const driverMap = new Map<number, OpenF1Driver>();
    driversRaw.forEach((d) => {
      if (d.driver_number) driverMap.set(d.driver_number, d);
    });

    // 2. Build time window query to avoid 50MB+ raw dumps
    let timeFilter = '';
    if (startParam && endParam) {
      timeFilter = `&date>${encodeURIComponent(startParam)}&date<${encodeURIComponent(endParam)}`;
    }

    const locRes = await fetch(
      `${OPENF1_BASE}/location?session_key=${sessionKey}${timeFilter}`,
      { next: { revalidate: 86400 } }
    );
    if (!locRes.ok) {
      throw new Error(`Location fetch failed: ${locRes.status}`);
    }
    const locations: OpenF1LocationPoint[] = await locRes.json();

    // Filter out [0,0,0] uninitialized points
    const validLocs = locations.filter((pt) => pt.x !== 0 || pt.y !== 0);
    if (validLocs.length === 0) {
      return NextResponse.json({ error: 'No valid telemetry found for window' }, { status: 404 });
    }

    // 3. Compute Bounding Box for 3D World Normalization
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    let minTime = Infinity,
      maxTime = -Infinity;

    for (const pt of validLocs) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minZ) minZ = pt.y; // OpenF1 'y' maps to horizontal Z in Three.js
      if (pt.y > maxZ) maxZ = pt.y;
      if (pt.z < minY) minY = pt.z; // OpenF1 'z' is elevation
      if (pt.z > maxY) maxY = pt.z;
    }

    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const centerY = (minY + maxY) / 2;
    const maxSpan = Math.max(maxX - minX, maxZ - minZ, 1);
    const TARGET_WORLD_SIZE = 400; // Fits cleanly in Three.js camera frustum
    const scale = TARGET_WORLD_SIZE / maxSpan;

    // 4. Group by Driver & Compute Headings
    const grouped = new Map<number, OpenF1LocationPoint[]>();
    for (const pt of validLocs) {
      const list = grouped.get(pt.driver_number) ?? [];
      list.push(pt);
      grouped.set(pt.driver_number, list);
    }

    const driversOutput: ComputedRaceTrace['drivers'] = {};
    let longestTrace: [number, number, number][] = [];

    for (const [driverNum, pts] of grouped.entries()) {
      pts.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      const samples: TelemetrySample[] = [];
      for (let i = 0; i < pts.length; i++) {
        const t = new Date(pts[i].date).getTime();
        if (t < minTime) minTime = t;
        if (t > maxTime) maxTime = t;

        const wx = (pts[i].x - centerX) * scale;
        const wy = (pts[i].z - centerY) * scale * 0.25; // Dampen elevation spikes
        const wz = -(pts[i].y - centerZ) * scale; // Invert Y for right-handed Z

        // Calculate heading from next or previous valid point
        let heading = 0;
        const nextPt = pts[Math.min(i + 1, pts.length - 1)];
        const prevPt = pts[Math.max(i - 1, 0)];
        const dx = (nextPt.x - prevPt.x) * scale;
        const dz = -(nextPt.y - prevPt.y) * scale;

        if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) {
          heading = Math.atan2(dx, dz);
        } else if (samples.length > 0) {
          heading = samples[samples.length - 1].heading;
        }

        samples.push({ t, x: wx, y: wy, z: wz, heading });
      }

      if (samples.length > longestTrace.length) {
        longestTrace = samples.slice(0, 650).map((s) => [s.x, s.y, s.z]);
      }

      const info = driverMap.get(driverNum) ?? {
        driver_number: driverNum,
        broadcast_name: `Driver #${driverNum}`,
        full_name: `Driver #${driverNum}`,
        name_acronym: `D${driverNum}`,
        team_name: 'Formula 1',
        team_colour: 'E10600',
        first_name: 'Driver',
        last_name: `#${driverNum}`,
        country_code: 'INT',
        session_key: sessionKey,
        meeting_key: 0,
      };

      driversOutput[driverNum] = { info, samples };
    }

    const payload: ComputedRaceTrace = {
      sessionKey,
      startTime: minTime,
      endTime: maxTime,
      bounds: { minX, maxX, minZ, maxZ, scale },
      trackOutline: longestTrace,
      drivers: driversOutput,
    };

    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      },
    });
  } catch (err) {
    console.error('[compute-trace error]:', err);
    return NextResponse.json({ error: 'Failed to compute race trace' }, { status: 500 });
  }
}