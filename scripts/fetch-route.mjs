// Fetches real road geometry from the public OSRM demo server and writes src/data/route.json.
// Run with: node scripts/fetch-route.mjs
import { writeFile } from 'node:fs/promises';

const stops = [
  { id: 'austin', name: 'Austin', lat: 30.2701, lon: -97.7313 },
  { id: 'lockhart', name: 'Lockhart', lat: 29.8861, lon: -97.6729 },
  { id: 'luling', name: "Luling Buc-ee's", lat: 29.6508, lon: -97.5935 },
  { id: 'cuero', name: 'Cuero', lat: 29.0939, lon: -97.2892 },
  { id: 'victoria', name: 'Victoria', lat: 28.8053, lon: -97.0036 },
  { id: 'kingsville', name: 'Kingsville', lat: 27.5163, lon: -97.8675 },
  { id: 'raymondville', name: 'Raymondville', lat: 26.4815, lon: -97.7831 },
  { id: 'brownsville', name: 'Brownsville', lat: 25.9017, lon: -97.4975 },
  { id: 'spi', name: 'South Padre Island', lat: 26.1037, lon: -97.1647 },
];
const recon = [
  { id: 'spi', lat: 26.1037, lon: -97.1647 },
  { id: 'starbase', lat: 25.9969, lon: -97.1546 },
];

async function route(points) {
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url, { headers: { 'user-agent': '77-to-starbase/0.1' } });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const json = await res.json();
  const r = json.routes[0];
  return {
    distanceMi: +(r.distance / 1609.344).toFixed(1),
    durationH: +(r.duration / 3600).toFixed(2),
    legs: r.legs.map((l) => ({ mi: +(l.distance / 1609.344).toFixed(1), min: Math.round(l.duration / 60) })),
    // [lat, lon] pairs, thinned to keep the bundle small.
    line: r.geometry.coordinates
      .filter((_, i, a) => i % 3 === 0 || i === a.length - 1)
      .map(([lon, lat]) => [+lat.toFixed(5), +lon.toFixed(5)]),
  };
}

const main = await route(stops);
const reconLeg = await route(recon);
await writeFile(
  new URL('../src/data/route.json', import.meta.url),
  JSON.stringify({ fetchedAt: new Date().toISOString().slice(0, 10), stops, main, recon: reconLeg }),
);
console.log(`main: ${main.distanceMi} mi, ${main.durationH} h, ${main.line.length} pts`);
console.log('legs:', main.legs);
console.log(`recon: ${reconLeg.distanceMi} mi, ${reconLeg.durationH} h`);
