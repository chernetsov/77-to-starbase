import L from 'leaflet';
import route from '../data/route.json';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const DARK = `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
const DARK_REF = `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`;
const DARK_ATTR = 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';
const SAT = `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`;
const SAT_ATTR = 'Imagery &copy; Esri, Maxar, Earthstar Geographics';

const ORANGE = '#e8622c';
const GREEN = '#3ddc84';

const notes: Record<string, string> = {
  austin: 'Pickup · barbecue · boots',
  lockhart: 'Barbecue capital of Texas',
  luling: "World's largest Buc-ee's",
  cuero: '',
  victoria: 'Join US-77 · Supercharger',
  kingsville: 'King Ranch Saddle Shop',
  raymondville: 'Ranch country',
  brownsville: '',
  spi: 'Hotel · beach · ceviche',
};
const major = new Set(['austin', 'luling', 'kingsville', 'spi']);

function label(name: string, sub: string, cls: string, stop?: { id: string; name: string }, attr: 'stop' | 'view' = 'stop') {
  const inner = `<span class="dot"></span><span class="txt"><b>${name}</b>${sub ? `<i>${sub}</i>` : ''}</span>`;
  return L.divIcon({
    className: `map-pin ${cls}`,
    html: stop
      ? `<button type="button" class="pin-hit" data-${attr}="${stop.id}" tabindex="-1" aria-label="${stop.name}: photos and notes">${inner}</button>`
      : inner,
    iconSize: [0, 0],
  });
}

// On touch screens one finger scrolls the page and two fingers move the map: with dragging off, Leaflet leaves
// `touch-action: pan-x pan-y`, and its pinch handler pans along with the fingers' midpoint.
const touch = matchMedia('(pointer: coarse)').matches;

function twoFingerHint(el: HTMLElement) {
  const hint = document.createElement('div');
  hint.className = 'map-hint';
  hint.textContent = 'Use two fingers to move the map';
  el.append(hint);
  let timer = 0;
  let start: { x: number; y: number } | null = null;
  el.addEventListener('touchstart', (e) => {
    start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    if (e.touches.length > 1) hint.classList.remove('shown');
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!start || e.touches.length !== 1) return;
    // Only sideways swipes look like an attempt to pan; vertical ones are just page scrolling.
    const dx = Math.abs(e.touches[0].clientX - start.x);
    const dy = Math.abs(e.touches[0].clientY - start.y);
    if (dx < 24 || dx < dy) return;
    hint.classList.add('shown');
    clearTimeout(timer);
    timer = window.setTimeout(() => hint.classList.remove('shown'), 1400);
  }, { passive: true });
}

function baseMap(el: HTMLElement, opts: L.MapOptions) {
  const map = L.map(el, {
    scrollWheelZoom: false,
    dragging: !touch,
    zoomSnap: 0.25,
    attributionControl: true,
    zoomControl: true,
    ...opts,
  });
  if (touch) twoFingerHint(el);
  return map;
}

export function initRouteMap(el: HTMLElement) {
  const map = baseMap(el, {});
  L.tileLayer(DARK, { attribution: DARK_ATTR, maxZoom: 16 }).addTo(map);
  L.tileLayer(DARK_REF, { maxZoom: 16, opacity: 0.55 }).addTo(map);

  const line = route.main.line as [number, number][];
  L.polyline(line, { color: '#000', weight: 8, opacity: 0.6 }).addTo(map);
  const main = L.polyline(line, { color: ORANGE, weight: 4 }).addTo(map);
  L.polyline(route.recon.line as [number, number][], { color: '#f2f2f2', weight: 2, dashArray: '4 6' }).addTo(map);

  let miles = 0;
  route.stops.forEach((s, i) => {
    if (i > 0) miles += route.main.legs[i - 1].mi;
    const side = ['lockhart', 'cuero', 'kingsville', 'raymondville', 'brownsville'].includes(s.id) ? 'left' : 'right';
    L.marker([s.lat, s.lon], {
      icon: label(
        s.name.toUpperCase(),
        `MI ${String(Math.round(miles)).padStart(3, '0')}${notes[s.id] ? ' · ' + notes[s.id] : ''}`,
        `${side} ${major.has(s.id) ? 'major' : ''} ${s.id === 'spi' ? 'up' : ''}`,
        s,
      ),
      keyboard: false,
    }).addTo(map);
  });
  L.marker([25.9969, -97.1546], {
    icon: label('STARBASE', 'Launch site · recon day', 'right launch down', { id: 'starbase', name: 'Starbase' }),
    keyboard: false,
  }).addTo(map);

  const fit = () => map.fitBounds(main.getBounds(), { padding: [40, 40] });
  fit();
  map.on('moveend', () => el.dispatchEvent(new CustomEvent('trip-map:moved', { bubbles: true })));
  new ResizeObserver(() => {
    map.invalidateSize();
    fit();
  }).observe(el);
}

function haversineKm(a: L.LatLngTuple, b: L.LatLngTuple) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function initViewingMap(el: HTMLElement) {
  const map = baseMap(el, {});
  L.tileLayer(SAT, { attribution: SAT_ATTR, maxZoom: 18 }).addTo(map);

  const pad: L.LatLngTuple = [25.9969, -97.1546];
  const islaBlanca: L.LatLngTuple = [26.0714, -97.1587];
  const tarpon: L.LatLngTuple = [26.0751, -97.2463];
  const starfactory: L.LatLngTuple = [25.9876, -97.1864];

  // The closure covers Highway 4 from the Starbase checkpoint to the beach.
  const closed = (route.recon.line as [number, number][]).filter(([lat, lon]) => lon > -97.24 && lat < 26.0);
  L.polyline(closed, { color: '#000', weight: 8, opacity: 0.6 }).addTo(map);
  L.polyline(closed, { color: ORANGE, weight: 4 }).addTo(map);

  // The drive in: the last leg from Brownsville, over the Queen Isabella Causeway to the hotel.
  const hotel: L.LatLngTuple = [route.stops.at(-1)!.lat, route.stops.at(-1)!.lon];
  const brownsville = route.stops.find((s) => s.id === 'brownsville')!;
  const mainLine = route.main.line as [number, number][];
  let legStart = 0;
  mainLine.forEach(([lat, lon], i) => {
    const d = (lat - brownsville.lat) ** 2 + (lon - brownsville.lon) ** 2;
    const best = mainLine[legStart];
    if (d < (best[0] - brownsville.lat) ** 2 + (best[1] - brownsville.lon) ** 2) legStart = i;
  });
  const toHotel = mainLine.slice(legStart);
  L.polyline(toHotel, { color: '#000', weight: 7, opacity: 0.55 }).addTo(map);
  L.polyline(toHotel, { color: '#f2f2f2', weight: 3 }).addTo(map);

  const km = haversineKm(islaBlanca, pad);
  L.polyline([islaBlanca, pad], { color: GREEN, weight: 2, dashArray: '6 6' }).addTo(map);
  L.polyline([tarpon, pad], { color: '#f2f2f2', weight: 1, dashArray: '3 7', opacity: 0.7 }).addTo(map);

  // Phone-width maps drop the subtitles and tuck the edge labels inward so the pins can spread out.
  const compact = el.clientWidth < 560;
  el.classList.toggle('compact', compact);
  const pin = (at: L.LatLngTuple, name: string, sub: string, cls: string, id: string, title: string) =>
    L.marker(at, { icon: label(name, sub, cls, { id, name: title }, 'view'), keyboard: false }).addTo(map);
  pin(pad, 'LAUNCH PADS', 'Pad 1 · Pad 2', 'right launch', 'pads', 'Launch pads');
  pin(starfactory, 'STARFACTORY', 'Where Starships are built', 'left', 'starfactory', 'Starfactory');
  pin(islaBlanca, 'ISLA BLANCA PARK', `${(km / 1.609).toFixed(1)} mi / ${km.toFixed(1)} km to the pads`, `${compact ? 'left' : 'right'} go`, 'islablanca', 'Isla Blanca Park');
  pin(tarpon, 'PORT ISABEL', 'Backup spot', compact ? 'above' : 'left', 'portisabel', 'Port Isabel');
  pin(hotel, 'HOTEL', 'Two nights on the island', 'right major', 'hotel', 'Hotel');
  pin(closed[Math.floor(closed.length * 0.12)], 'HWY 4', 'Closed on launch day', 'below closed', 'hwy4', 'Highway 4');

  // Labels hang off their pins: west-edge labels point west over land, east-edge ones out over the Gulf.
  const bounds = L.latLngBounds([pad, islaBlanca, tarpon, starfactory, hotel]);
  const fit = () => {
    map.fitBounds(bounds, compact ? { paddingTopLeft: [30, 40], paddingBottomRight: [120, 50] } : { paddingTopLeft: [150, 40], paddingBottomRight: [190, 70] });
  };
  fit();
  map.on('moveend', () => el.dispatchEvent(new CustomEvent('trip-map:moved', { bubbles: true })));
  new ResizeObserver(() => {
    map.invalidateSize();
    fit();
  }).observe(el);
}
