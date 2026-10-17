import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface Point { lat: number; lon: number; label?: string }

const pin = (cls: string) => L.divIcon({ className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [26, 26], iconAnchor: [13, 26] });

/** OpenStreetMap view showing points and an optional route line. */
export function RouteMap({ points, line, height = 360 }: { points: Point[]; line?: [number, number][]; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([47.16, 19.5], 7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => { map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    if (line?.length) {
      L.polyline(line, { color: '#0b1630', weight: 7, opacity: 0.9 }).addTo(g);
      L.polyline(line, { color: '#00a8ff', weight: 3, dashArray: '8 10' }).addTo(g);
      bounds.push(...line);
    }
    points.forEach((p, i) => {
      const mk = L.marker([p.lat, p.lon], { icon: pin(i === points.length - 1 && points.length > 1 ? 'end' : '') }).addTo(g);
      if (p.label) mk.bindTooltip(p.label);
      bounds.push([p.lat, p.lon]);
    });
    if (bounds.length === 1) m.setView(bounds[0], 14);
    else if (bounds.length) m.fitBounds(L.latLngBounds(bounds), { padding: [36, 36] });
    setTimeout(() => m.invalidateSize(), 50);
  }, [points, line]);

  return <div ref={el} className="map" style={{ height }} />;
}
