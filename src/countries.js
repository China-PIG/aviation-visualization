/* Natural Earth polygons, indexed for use by the offline globe. */
const CountryBoundaries = (() => {
  "use strict";

  const outside = { code: "outside", name: "边界外／未匹配", english: "Outside or unmatched" };
  const bands = [
    [1, 9, "#6c522d"], [10, 49, "#987034"],
    [50, 199, "#c18a36"], [200, Infinity, "#efa942"],
  ];
  const tint = count => bands.find(([min, max]) => count >= min && count <= max)?.[2];

  function inRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j], [x2, y2] = ring[i];
      if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) inside = !inside;
    }
    return inside;
  }

  function gridX(lon) {
    return Math.max(0, Math.min(35, Math.floor((lon + 180) / 10)));
  }

  function gridY(lat) {
    return Math.max(0, Math.min(17, Math.floor((lat + 90) / 10)));
  }

  function gridKey(x, y) {
    return y * 36 + x;
  }

  function load(rows) {
    const grid = Array.from({ length: 36 * 18 }, () => []);
    const countries = rows.map(([code, name, english, center, polygons]) => {
      const outline = new Path2D();
      const area = { code, name, english, center, outline, labelArea: 0 };
      for (const rings of polygons) {
        let minX = 180, minY = 90, maxX = -180, maxY = -90;
        for (const ring of rings) {
          outline.moveTo(...ring[0]);
          for (const [x, y] of ring) outline.lineTo(x, y);
          outline.closePath();
        }
        for (const [lon, lat] of rings[0]) {
          minX = Math.min(lon, minX);
          maxX = Math.max(lon, maxX);
          minY = Math.min(lat, minY);
          maxY = Math.max(lat, maxY);
        }
        const size = (maxX - minX) * (maxY - minY);
        const latitude = (minY + maxY) / 2;
        area.labelArea = Math.max(area.labelArea, size * Math.cos(latitude * Math.PI / 180));
        const item = { area, rings, minX, minY, maxX, maxY, size };
        for (let y = gridY(minY); y <= gridY(maxY); y++) {
          for (let x = gridX(minX); x <= gridX(maxX); x++) grid[gridKey(x, y)].push(item);
        }
      }
      return area;
    });
    for (const cell of grid) cell.sort((a, b) => a.size - b.size);
    const byCode = new Map([...countries, outside].map(area => [area.code, area]));
    const at = (lon, lat) => {
      const candidates = grid[gridKey(gridX(lon), gridY(lat))];
      for (const polygon of candidates) {
        if (lon < polygon.minX || lon > polygon.maxX || lat < polygon.minY || lat > polygon.maxY) continue;
        const [exterior, ...holes] = polygon.rings;
        if (inRing(lon, lat, exterior) && !holes.some(ring => inRing(lon, lat, ring))) return polygon.area;
      }
      return outside;
    };
    return { countries, byCode, at };
  }

  function paint(context, geography, counts, selection, showTotals) {
    const { width, height } = context.canvas;
    context.save();
    context.setTransform(width / 360, 0, 0, -height / 180, width / 2, height / 2);
    if (showTotals) {
      for (const area of geography.countries) {
        const fill = tint(counts.get(area.code) || 0);
        if (!fill) continue;
        context.fillStyle = fill;
        context.fill(area.outline, "evenodd");
      }
    }
    context.strokeStyle = showTotals ? "#c4c9d47a" : "#becad96a";
    context.lineWidth = showTotals ? .15 : .115;
    for (const area of geography.countries) context.stroke(area.outline);
    const current = geography.byCode.get(selection);
    if (current?.outline) {
      if (!showTotals) {
        context.fillStyle = "#b7852d45";
        context.fill(current.outline, "evenodd");
      }
      context.strokeStyle = "#fff0ad";
      context.lineWidth = .31;
      context.stroke(current.outline);
    }
    context.restore();
  }

  return { load, paint, bands };
})();
