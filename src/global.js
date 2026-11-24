(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const snapshot = JSON.parse($("#snapshot").textContent);
  const geography = CountryBoundaries.load(JSON.parse($("#countries").textContent));
  const rad = Math.PI / 180;
  const nf = new Intl.NumberFormat("zh-CN");
  const count = n => nf.format(n);
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;
  const anchors = { atlantic: [-38, 30], america: [-100, 27], europe: [18, 34], asia: [113, 23] };
  const COUNTRY_ZOOM = 1.2;
  const CITY_ZOOM = 1.55;
  const MAX_ZOOM = 6.25;
  const detailLevel = zoom => zoom < COUNTRY_ZOOM ? "world" : zoom < CITY_ZOOM ? "countries" : "cities";
  const worldLabels = [
    ["北美洲", -105, 51], ["南美洲", -62, -15], ["欧洲", 26, 58], ["非洲", 20, 12],
    ["亚洲", 92, 51], ["大洋洲", 137, -28], ["太平洋", -145, 8], ["大西洋", -38, -5], ["印度洋", 80, -24],
  ];
  const bands = [
    ["low", "低于 3,000 米"], ["mid", "3,000–8,999 米"],
    ["high", "9,000 米及以上"], ["missing", "高度缺失"],
  ];
  const bandOf = height => height === null ? "missing" : height < 3000 ? "low" : height < 9000 ? "mid" : "high";
  const location = (value, positive, negative, digits = 2) => `${Math.abs(value).toFixed(digits)}° ${value < 0 ? negative : positive}`;
  const coordinate = (lon, lat, digits) => `${location(lat, "N", "S", digits)}  ${location(lon, "E", "W", digits)}`;

  function vector(lon, lat) {
    const longitude = lon * rad, latitude = lat * rad;
    const cosLat = Math.cos(latitude);
    return [cosLat * Math.cos(longitude), cosLat * Math.sin(longitude), Math.sin(latitude)];
  }

  function frame(lon, lat) {
    const longitude = lon * rad, latitude = lat * rad;
    const sinLon = Math.sin(longitude), cosLon = Math.cos(longitude);
    const sinLat = Math.sin(latitude), cosLat = Math.cos(latitude);
    return {
      forward: [cosLat * cosLon, cosLat * sinLon, sinLat],
      east: [-sinLon, cosLon, 0],
      north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    };
  }

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const planes = snapshot.aircraft.map(([lon, lat, height, speed, heading, age], index) => {
    const basis = frame(lon, lat);
    const bearing = heading === null ? 0 : heading * rad;
    const tangent = basis.north.map((component, i) => component * Math.cos(bearing) + basis.east[i] * Math.sin(bearing));
    return { id: index + 1, lon, lat, height, speed, heading, age, tangent,
      position: basis.forward, band: bandOf(height), country: geography.at(wrap(lon), lat).code };
  });
  const time = new Date(snapshot.observedAt * 1000);
  $("#snapshot-time").dateTime = time.toISOString();
  $("#snapshot-time").textContent = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(time);
  $("#total-count").textContent = count(planes.length);

  $("#altitude-bars").innerHTML = bands.map(([key, label]) => `
    <button type="button" data-band="${key}" aria-pressed="false">
      <span><span>${label}</span><b></b></span><i aria-hidden="true"><b></b></i>
    </button>`).join("");

  const state = { view: "globe", layer: "planes", region: "atlantic", zoom: 1, altitude: "all", country: "all",
    lon: anchors.atlantic[0], lat: anchors.atlantic[1] };
  const countryResults = $("#country-results");
  const countrySearch = $("#country-search");
  const countrySort = new Intl.Collator("zh-CN");
  let countryCounts = new Map();
  let selected = null;
  let hovered = null;
  let filtered = planes;
  let bins = [];
  let hitItems = [];
  let view = null;
  let drag = null;
  let animation = 0;
  let texture = null;
  let textureReady = false;
  let rasterKey = "";
  const stage = $("#stage");
  const earthCanvas = $("#earth");
  const trafficCanvas = $("#traffic");
  const earth = earthCanvas.getContext("2d");
  const traffic = trafficCanvas.getContext("2d");
  const raster = document.createElement("canvas");
  const rasterCtx = raster.getContext("2d");
  const baseTexture = document.createElement("canvas");
  const flatTexture = document.createElement("canvas");
  const popup = $("#map-popup");

  function densityBins() {
    const cells = new Map();
    for (const plane of filtered) {
      const lon = Math.floor(wrap(plane.lon) / 5) * 5;
      const lat = Math.min(85, Math.floor(plane.lat / 5) * 5);
      const key = `${lon},${lat}`;
      if (!cells.has(key)) {
        const center = [lon + 2.5, lat + 2.5];
        cells.set(key, { key, lon, lat, center, position: vector(...center), count: 0 });
      }
      cells.get(key).count++;
    }
    return [...cells.values()];
  }

  function sprite(angle) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 34;
    const ctx = canvas.getContext("2d");
    ctx.translate(17, 17);
    ctx.rotate(angle);
    const glyph = new Path2D("M0 -11 Q1.5 -11 1.8 -7 L2 -3 L10 2 L10 4 L2 2 L1.4 7 L4.2 9 L4.2 11 L0 9.5 L-4.2 11 L-4.2 9 L-1.4 7 L-2 2 L-10 4 L-10 2 L-2 -3 L-1.8 -7 Q-1.5 -11 0 -11Z");
    ctx.fillStyle = "#ffce4b";
    ctx.fill(glyph);
    ctx.strokeStyle = "#634315";
    ctx.lineWidth = .9;
    ctx.stroke(glyph);
    return canvas;
  }

  const sprites = Array.from({ length: 36 }, (_, index) => sprite(index * Math.PI / 18));
  const mapPoint = (name, lon, lat) => ({ name, lon, lat, position: vector(lon, lat) });
  const worldPlaces = worldLabels.map(row => mapPoint(...row));
  const countryPlaces = geography.countries
    .map(area => ({ ...mapPoint(area.name, ...area.center), code: area.code, span: Math.sqrt(area.labelArea) }))
    .sort((a, b) => b.span - a.span);
  const cityPlaces = JSON.parse($("#cities").textContent)
    .map(([name, lon, lat, rank]) => ({ ...mapPoint(name, lon, lat), rank }));

  function prepareTexture(image) {
    baseTexture.width = flatTexture.width = image.naturalWidth;
    baseTexture.height = flatTexture.height = image.naturalHeight;
    const ctx = baseTexture.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, baseTexture.width, baseTexture.height);
    const data = pixels.data;
    for (let i = 0; i < data.length; i += 4) {
      const [red, green, blue] = [data[i], data[i + 1], data[i + 2]];
      const luminance = .24 * red + .63 * green + .13 * blue;
      const land = clamp((red + green - blue * 1.3) / 65, 0, 1);
      data[i] = 23 + .32 * luminance + 16 * land;
      data[i + 1] = 27 + .34 * luminance + 16 * land;
      data[i + 2] = 34 + .35 * luminance + 13 * land;
    }
    ctx.putImageData(pixels, 0, 0);
  }

  function paintGeography() {
    if (!textureReady) return;
    const ctx = flatTexture.getContext("2d", { willReadFrequently: true });
    const { width, height } = flatTexture;
    ctx.drawImage(baseTexture, 0, 0);
    CountryBoundaries.paint(ctx, geography, countryCounts, state.country, state.layer === "countries");
    texture = { width, height, pixels: ctx.getImageData(0, 0, width, height).data };
    rasterKey = "";
  }

  function updateRaster(limit) {
    const { width, height, cx, cy, radius, basis } = view;
    const left = Math.max(0, cx - radius);
    const top = Math.max(0, cy - radius);
    const spanX = Math.min(width, cx + radius) - left;
    const spanY = Math.min(height, cy + radius) - top;
    // Sample only the visible part of the sphere when zoomed in.
    const ratio = Math.min(1, limit / Math.max(spanX, spanY));
    const cols = Math.max(1, Math.round(spanX * ratio));
    const rows = Math.max(1, Math.round(spanY * ratio));
    const key = `${state.lon}/${state.lat}/${radius}/${left}/${top}/${spanX}/${spanY}/${cols}/${rows}`;
    if (rasterKey !== key) {
      rasterKey = key;
      raster.width = cols;
      raster.height = rows;
      const { forward: [fx, fy, fz], east: [ex, ey], north: [nx, ny, nz] } = basis;
      const image = rasterCtx.createImageData(cols, rows);
      const result = image.data;
      const stepX = spanX / cols / radius;
      const stepY = spanY / rows / radius;
      const startX = (left - cx) / radius + stepX / 2;
      const startY = (cy - top) / radius - stepY / 2;
      for (let row = 0; row < rows; row++) {
        const north = startY - row * stepY;
        const depthAtMeridian = 1 - north * north;
        for (let col = 0; col < cols; col++) {
          const east = startX + col * stepX;
          const depthSquared = depthAtMeridian - east * east;
          if (depthSquared <= 0) continue;
          const depth = Math.sqrt(depthSquared);
          const x = fx * depth + ex * east + nx * north;
          const y = fy * depth + ey * east + ny * north;
          const z = fz * depth + nz * north;
          const texX = clamp(Math.floor((Math.atan2(y, x) / (Math.PI * 2) + .5) * texture.width), 0, texture.width - 1);
          const texY = clamp(Math.floor((.5 - Math.asin(clamp(z, -1, 1)) / Math.PI) * texture.height), 0, texture.height - 1);
          const texel = (texY * texture.width + texX) * 4;
          const out = (row * cols + col) * 4;
          const light = .73 + .34 * Math.max(0, depth * .8 - east * .34 + north * .42);
          const rim = (1 - depth) ** 4 * 16;
          result[out] = texture.pixels[texel] * light + rim * .6;
          result[out + 1] = texture.pixels[texel + 1] * light + rim * .85;
          result[out + 2] = texture.pixels[texel + 2] * light + rim;
          result[out + 3] = 255;
        }
      }
      rasterCtx.putImageData(image, 0, 0);
    }
    earth.drawImage(raster, left, top, spanX, spanY);
  }

  function makeView(width, height) {
    const globe = state.view === "globe";
    const cx = width / 2, cy = height / 2;
    const radius = Math.min(width * .438, height * .437) * state.zoom;
    const mapWidth = Math.max(1, Math.min(width - 32, (height - 92) * 2)) * state.zoom;
    const scale = mapWidth / 360;
    const maxLon = Math.max(0, 180 - (cx - 16) / scale);
    const maxLat = Math.max(0, 90 - (cy - 16) / scale);
    const lon = globe ? state.lon : clamp(state.lon, -maxLon, maxLon);
    const lat = globe ? state.lat : clamp(state.lat, -maxLat, maxLat);
    return { globe, width, height, cx, cy, radius, mapWidth, mapHeight: mapWidth / 2,
      scale, lon, lat, maxLon, maxLat, basis: globe ? frame(lon, lat) : null };
  }

  function project(lon, lat, position) {
    const { globe, cx, cy, radius, scale, basis } = view;
    if (!globe) return { x: cx + (lon - view.lon) * scale, y: cy - (lat - view.lat) * scale, depth: 1 };
    const unit = position || vector(lon, lat);
    const depth = dot(unit, basis.forward);
    return { x: cx + dot(unit, basis.east) * radius, y: cy - dot(unit, basis.north) * radius, depth };
  }

  function unproject(x, y, projection = view) {
    const { globe, cx, cy, radius, scale, basis } = projection;
    if (!globe) {
      const lon = projection.lon + (x - cx) / scale;
      const lat = projection.lat + (cy - y) / scale;
      return Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? [lon, lat] : null;
    }
    const east = (x - cx) / radius, north = (cy - y) / radius;
    const depthSquared = 1 - east * east - north * north;
    if (depthSquared < 0) return null;
    const depth = Math.sqrt(depthSquared);
    const world = basis.forward.map((component, i) => component * depth + basis.east[i] * east + basis.north[i] * north);
    return [wrap(Math.atan2(world[1], world[0]) / rad), Math.asin(clamp(world[2], -1, 1)) / rad];
  }

  function countryAtPoint(x, y) {
    const location = unproject(x, y);
    return location ? geography.at(...location) : null;
  }

  function drawBase(quick) {
    const { width, height, globe, cx, cy, radius, mapWidth, mapHeight } = view;
    earth.clearRect(0, 0, width, height);
    if (globe) {
      const glow = earth.createRadialGradient(cx, cy, radius * .96, cx, cy, radius * 1.095);
      glow.addColorStop(0, "#677b9d42");
      glow.addColorStop(.37, "#52678330");
      glow.addColorStop(1, "#52678300");
      earth.fillStyle = glow;
      earth.fillRect(0, 0, width, height);
      earth.beginPath();
      earth.arc(cx, cy, radius, 0, Math.PI * 2);
      earth.fillStyle = "#232c3b";
      earth.fill();
      if (texture) updateRaster(quick ? 300 : 740);
      earth.strokeStyle = "#8a9bb24b";
      earth.lineWidth = 1.2;
      earth.stroke();
    } else {
      const corner = project(-180, 90);
      if (texture) earth.drawImage(flatTexture, corner.x, corner.y, mapWidth, mapHeight);
      earth.strokeStyle = "#71819756";
      earth.strokeRect(corner.x, corner.y, mapWidth, mapHeight);
    }
    drawGrid();
  }

  function drawGrid() {
    earth.lineWidth = .7;
    earth.strokeStyle = "#b6c4db2b";
    const line = (a, b, every, getPoint) => {
      earth.beginPath();
      let drawing = false;
      for (let value = a; value <= b; value += every) {
        const [lon, lat] = getPoint(value);
        const point = project(lon, lat);
        if (point.depth < 0) {
          drawing = false;
          continue;
        }
        if (drawing) earth.lineTo(point.x, point.y);
        else earth.moveTo(point.x, point.y);
        drawing = true;
      }
      earth.stroke();
    };
    for (let lat = -60; lat <= 60; lat += 30) line(-180, 180, 3, lon => [lon, lat]);
    for (let lon = -180; lon < 180; lon += 30) line(-90, 90, 3, lat => [lon, lat]);
  }

  function inside(point) {
    return point.depth >= 0 && point.x >= 0 && point.x <= view.width && point.y >= 0 && point.y <= view.height;
  }

  function drawPlane(plane, point, active) {
    const angle = plane.heading === null ? 0 : view.globe
      ? Math.atan2(dot(plane.tangent, view.basis.east), dot(plane.tangent, view.basis.north))
      : Math.atan2(Math.sin(plane.heading * rad) / Math.max(.15, Math.cos(plane.lat * rad)), Math.cos(plane.heading * rad));
    const spriteIndex = (Math.round(angle / (Math.PI / 18)) + 36) % 36;
    const size = active ? 23 : view.width < 580 ? 9 : 11.5;
    traffic.globalAlpha = active ? 1 : view.globe ? .52 + point.depth * .36 : .76;
    if (plane.heading === null && !active) {
      traffic.fillStyle = "#ffce4b";
      traffic.beginPath();
      traffic.arc(point.x, point.y, 1.2, 0, Math.PI * 2);
      traffic.fill();
    } else {
      traffic.drawImage(sprites[spriteIndex], point.x - size / 2, point.y - size / 2, size, size);
    }
    traffic.globalAlpha = 1;
    if (!active) return;
    traffic.beginPath();
    traffic.arc(point.x, point.y, 12, 0, Math.PI * 2);
    traffic.strokeStyle = "#fff1b2";
    traffic.lineWidth = 1.25;
    traffic.stroke();
  }

  function drawDensity() {
    const cellSize = view.globe ? view.radius * (5 * rad) : view.mapWidth / 72;
    for (const bin of bins) {
      const point = project(...bin.center, bin.position);
      if (!inside(point)) continue;
      const ratio = Math.min(1, Math.log2(bin.count + 1) / 7);
      const size = cellSize * (view.globe ? .55 + .42 * point.depth : .96);
      traffic.fillStyle = `rgba(255,${Math.round(218 - 93 * ratio)},${Math.round(85 - 56 * ratio)},${.18 + ratio * .75})`;
      traffic.fillRect(point.x - size / 2, point.y - size / 2, size, size);
      if (selected?.key === bin.key) {
        traffic.strokeStyle = "#fff2c3";
        traffic.lineWidth = 1.5;
        traffic.strokeRect(point.x - size / 2, point.y - size / 2, size, size);
      }
      hitItems.push({ item: bin, ...point, size });
    }
  }

  function drawPlaceNames() {
    const level = detailLevel(state.zoom);
    const small = view.width < 580;
    const placed = [];
    const labelLimit = small ? 22 : 43;
    const pixelsPerDegree = view.globe ? view.radius * rad : view.scale;
    traffic.save();
    traffic.textBaseline = "middle";
    traffic.lineJoin = "round";

    function drawName(place, type) {
      const point = project(place.lon, place.lat, place.position);
      if (point.depth < .2 || !inside(point) || placed.length >= labelLimit) return;
      const city = type === "city";
      const selectedCountry = type === "country" && place.code === state.country;
      const fontSize = small ? (city ? 11 : 10) : (city ? 12 : 13);
      traffic.font = `${city ? "500" : "650"} ${fontSize}px system-ui`;
      const width = traffic.measureText(place.name).width;
      if (type === "country" && !selectedCountry && place.span * pixelsPerDegree * Math.sqrt(point.depth) < width * .7) return;
      const leftOptions = city ? [point.x + 6, point.x - width - 6] : [point.x - width / 2];
      for (const left of leftOptions) {
        const box = { left: left - 4, right: left + width + 4, top: point.y - fontSize / 2 - 4, bottom: point.y + fontSize / 2 + 4 };
        if (box.left < 5 || box.right > view.width - 5 || box.top < 36 || box.bottom > view.height - 43) continue;
        if (box.right > view.width - 49 && box.bottom > view.height - 118) continue;
        if (placed.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue;
        placed.push(box);
        if (city) {
          traffic.beginPath();
          traffic.arc(point.x, point.y, 2, 0, Math.PI * 2);
          traffic.lineWidth = 1.7;
          traffic.strokeStyle = "#131a24";
          traffic.stroke();
          traffic.fillStyle = "#d5ecff";
          traffic.fill();
        }
        traffic.textAlign = "left";
        traffic.lineWidth = type === "world" ? 2 : 3;
        traffic.strokeStyle = "#0d121be8";
        traffic.strokeText(place.name, left, point.y);
        traffic.fillStyle = selectedCountry ? "#ffe4a2" : city ? "#e5f3ff"
          : level === "cities" || type === "world" ? "#aebdcd" : "#e2e9ee";
        traffic.fillText(place.name, left, point.y);
        return;
      }
    }

    if (level === "world") {
      for (const placeName of worldPlaces) drawName(placeName, "world");
    } else {
      const selectedCountry = countryPlaces.find(area => area.code === state.country);
      if (selectedCountry) drawName(selectedCountry, "country");
      if (level === "cities") {
        const maxRank = state.zoom < 2.65 ? 2 : state.zoom < 3.8 ? 4 : state.zoom < 5.25 ? 6 : 8;
        for (const city of cityPlaces) {
          if (city.rank > maxRank || placed.length >= labelLimit) break;
          drawName(city, "city");
        }
      }
      for (const area of countryPlaces) {
        if (area === selectedCountry) continue;
        if (level === "cities" && area.span < 12) break;
        drawName(area, "country");
      }
    }
    traffic.restore();
  }

  function drawTraffic() {
    traffic.clearRect(0, 0, view.width, view.height);
    hitItems = [];
    let visible = 0;
    let activePlane = null;
    for (const plane of filtered) {
      const point = project(plane.lon, plane.lat, plane.position);
      if (!inside(point)) continue;
      visible++;
      if (state.layer !== "planes") continue;
      if (selected?.id === plane.id) activePlane = { plane, point };
      else drawPlane(plane, point, false);
      hitItems.push({ item: plane, ...point });
    }
    if (state.layer === "density") drawDensity();
    drawPlaceNames();
    if (activePlane) drawPlane(activePlane.plane, activePlane.point, true);
    const text = count(visible) + " 架";
    if ($("#visible-count").textContent !== text) $("#visible-count").textContent = text;
    const country = geography.byCode.get(state.country);
    $("#center-readout").textContent = country ? `${country.name} · ${count(filtered.length)} 架`
      : view.globe || state.zoom > 1 ? coordinate(view.lon, view.lat, 1) : "全球平面视图";
    if (visible === 0 && state.layer !== "countries") {
      traffic.font = "13px system-ui";
      traffic.textAlign = "center";
      traffic.fillStyle = "#eff0ed";
      traffic.fillText("当前视图无匹配观测", view.cx, view.height - 47);
    }
  }

  function render(quick = false) {
    const { width, height } = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const canvas of [earthCanvas, trafficCanvas]) {
      const nextWidth = Math.round(width * dpr), nextHeight = Math.round(height * dpr);
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
    }
    earth.setTransform(dpr, 0, 0, dpr, 0, 0);
    traffic.setTransform(dpr, 0, 0, dpr, 0, 0);
    view = makeView(width, height);
    drawBase(quick);
    drawTraffic();
  }

  function schedule() {
    if (animation) return;
    animation = requestAnimationFrame(() => {
      animation = 0;
      render(Boolean(drag?.moved));
    });
  }

  const observationName = plane => `观测 ${String(plane.id).padStart(4, "0")}`;
  const measured = (value, unit) => value === null ? "—" : `${count(value)} ${unit}`;

  function updateDetails(item) {
    selected = item;
    const link = $("#selection-link");
    const country = geography.byCode.get(state.country);
    link.hidden = !item && !country;
    if (item) {
      const title = state.layer === "planes" ? observationName(item) : `${count(item.count)} 架飞机`;
      link.textContent = `${title} · 查看详情 ↓`;
    } else if (country) {
      link.textContent = `${country.name} · 查看统计 ↓`;
    }
    if (!item) {
      const copy = {
        planes: ["飞机详情", "点击地图上的飞机，查看该位置的高度、地速和航向。"],
        density: ["网格详情", "点击有颜色的区域，查看该 5° × 5° 网格内的观测数量。"],
        countries: ["国家和地区", "点选地图上的国家或地区，在上方查看观测架数和高度分布。"],
      };
      const [heading, description] = copy[state.layer];
      $("#detail").innerHTML = `<h2>${heading}</h2><p>${description}</p>`;
    } else if (state.layer === "planes") {
      const { lon, lat, height, speed, heading, age } = item;
      $("#detail").innerHTML = `
        <div class="detail-head"><h2>飞机详情</h2><button type="button" data-clear aria-label="清除选中">×</button></div>
        <strong class="detail-title">${observationName(item)}</strong><p class="detail-coords">${coordinate(lon, lat)}</p>
        <dl><div><dt>高度</dt><dd>${measured(height, "m")}</dd></div><div><dt>地速</dt><dd>${measured(speed, "km/h")}</dd></div>
          <div><dt>航向</dt><dd>${measured(heading, "°")}</dd></div><div><dt>位置报告距快照</dt><dd>${age} 秒</dd></div></dl>
        <p>所在区域 · ${geography.byCode.get(item.country).name}</p>`;
    } else {
      const [lon, lat] = item.center;
      $("#detail").innerHTML = `<div class="detail-head"><h2>网格详情</h2><button type="button" data-clear aria-label="清除选中">×</button></div>
        <strong class="detail-title">${count(item.count)} 架</strong><p class="detail-coords">${coordinate(lon, lat, 1)} · 网格中心</p>
        <dl><div><dt>纬度</dt><dd>${item.lat}° 至 ${item.lat + 5}°</dd></div><div><dt>经度</dt><dd>${item.lon}° 至 ${item.lon + 5}°</dd></div></dl>`;
    }
    if (view) drawTraffic();
  }

  function updateControls() {
    const globe = state.view === "globe";
    for (const button of document.querySelectorAll("[data-view]")) button.setAttribute("aria-pressed", state.view === button.dataset.view);
    for (const button of document.querySelectorAll("[data-layer]")) button.setAttribute("aria-pressed", state.layer === button.dataset.layer);
    for (const button of document.querySelectorAll("[data-region]")) button.setAttribute("aria-pressed", globe && state.region === button.dataset.region);
    for (const button of document.querySelectorAll("[data-band]")) button.setAttribute("aria-pressed", state.altitude === button.dataset.band);
    $("#altitude").value = state.altitude;
    $("#zoom-in").disabled = state.zoom >= MAX_ZOOM;
    $("#zoom-out").disabled = state.zoom <= (globe ? .72 : 1);
    trafficCanvas.classList.toggle("flat", !globe);
    trafficCanvas.classList.toggle("pannable", globe || state.zoom > 1);
    const level = detailLevel(state.zoom);
    const scale = $("#map-scale");
    if (scale.dataset.level !== level) {
      scale.dataset.level = level;
      scale.textContent = { world: "全球概览", countries: "国家和地区", cities: "城市" }[level];
    }
    $("#map-help").textContent = level === "world" ? "放大查看国家和城市"
      : level === "countries" ? "继续放大查看城市" : (globe ? "拖动旋转 · ＋／− 缩放" : "拖动平移 · ＋／− 缩放");
    const legend = $("#legend");
    if (state.layer === "countries") {
      legend.innerHTML = CountryBoundaries.bands.map(([min, max, color]) =>
        `<span class="country-key"><i style="background:${color}"></i>${max === Infinity ? "≥" + min : min + "–" + max}</span>`).join("");
      legend.prepend("各地观测架数 ");
    } else {
      legend.innerHTML = state.layer === "planes" ? '<i class="legend-plane" aria-hidden="true">✈</i> 每个标记代表一架观测飞机'
        : '<i class="legend-scale" aria-hidden="true"></i> 每格飞机数 <span>少 → 多</span>';
    }
  }

  const areaCount = code => countryCounts.get(code) || 0;

  function renderCountries() {
    const query = countrySearch.value.trim().toLocaleLowerCase();
    const matches = geography.countries.filter(area =>
      [area.name, area.english, area.code].some(value => value.toLocaleLowerCase().includes(query)));
    matches.sort((a, b) => areaCount(b.code) - areaCount(a.code) || countrySort.compare(a.name, b.name));
    const outside = geography.byCode.get("outside");
    if (!query || outside.name.includes(query)) matches.push(outside);
    countryResults.replaceChildren();
    for (const area of matches) {
      const row = document.createElement("button");
      row.type = "button";
      row.dataset.country = area.code;
      row.setAttribute("aria-pressed", state.country === area.code);
      const name = document.createElement("span"), value = document.createElement("b");
      name.textContent = area.name;
      value.textContent = count(areaCount(area.code));
      row.append(name, value);
      countryResults.append(row);
    }
    if (!matches.length) countryResults.textContent = "未找到匹配的国家或地区";
    const active = geography.byCode.get(state.country);
    $("#country-summary").textContent = active
      ? `${active.name} · ${count(filtered.length)} 架`
      : `${count(countryCounts.size - Number(countryCounts.has("outside")))} 个国家和地区有观测`;
  }

  function refreshFilter() {
    countryCounts = new Map();
    const heights = Object.fromEntries(bands.map(([key]) => [key, 0]));
    filtered = [];
    let countryTotal = 0;
    for (const plane of planes) {
      const inCountry = state.country === "all" || plane.country === state.country;
      if (inCountry) {
        heights[plane.band]++;
        countryTotal++;
      }
      if (state.altitude !== "all" && plane.band !== state.altitude) continue;
      countryCounts.set(plane.country, areaCount(plane.country) + 1);
      if (inCountry) filtered.push(plane);
    }
    for (const [key] of bands) {
      const button = $(`[data-band="${key}"]`);
      button.querySelector("span b").textContent = count(heights[key]);
      button.querySelector("i b").style.width = `${countryTotal ? heights[key] / countryTotal * 100 : 0}%`;
    }
    bins = densityBins();
    renderCountries();
    updateDetails(null);
    updateControls();
    paintGeography();
    schedule();
  }

  function chooseCountry(code, centerMap) {
    state.country = code;
    const area = geography.byCode.get(code);
    if (centerMap && area?.center && (state.view === "globe" || state.zoom > 1)) {
      [state.lon, state.lat] = area.center;
      state.region = "";
    }
    refreshFilter();
  }

  function region(key) {
    [state.lon, state.lat] = anchors[key];
    state.zoom = 1;
    state.region = key;
    state.view = "globe";
    updateControls();
    schedule();
  }

  function moveCenter(lon, lat, projection) {
    if (projection.globe) {
      state.lon = wrap(lon);
      state.lat = clamp(lat, -85, 85);
    } else {
      state.lon = clamp(lon, -projection.maxLon, projection.maxLon);
      state.lat = clamp(lat, -projection.maxLat, projection.maxLat);
    }
    state.region = "";
  }

  function zoomBy(factor, pointer) {
    const before = makeView(view.width, view.height);
    const zoom = clamp(state.zoom * factor, before.globe ? .72 : 1, MAX_ZOOM);
    if (zoom === state.zoom) return;
    const anchor = pointer && unproject(...pointer, before);
    const magnification = zoom / state.zoom;
    state.zoom = zoom;
    if (before.globe && anchor && magnification > 1) {
      const amount = 1 - 1 / magnification;
      moveCenter(before.lon + wrap(anchor[0] - before.lon) * amount,
        before.lat + (anchor[1] - before.lat) * amount, before);
    } else if (!before.globe) {
      const next = makeView(before.width, before.height);
      const lon = anchor ? anchor[0] - (pointer[0] - next.cx) / next.scale : before.lon;
      const lat = anchor ? anchor[1] + (pointer[1] - next.cy) / next.scale : before.lat;
      moveCenter(lon, lat, next);
    }
    updateControls();
    schedule();
  }

  function closest(x, y, fromKeyboard = false) {
    let best = null;
    const cells = state.layer === "density";
    let distance = fromKeyboard || cells ? Infinity : 121;
    for (const point of hitItems) {
      const dx = point.x - x, dy = point.y - y;
      if (cells && !fromKeyboard && Math.max(Math.abs(dx), Math.abs(dy)) > point.size / 2) continue;
      const next = dx * dx + dy * dy;
      if (next <= distance) {
        best = point;
        distance = next;
      }
    }
    return best;
  }

  function showHover(point, x, y) {
    if (point?.item === hovered && !popup.hidden) return;
    hovered = point?.item || null;
    popup.hidden = !hovered;
    if (!hovered) return;
    popup.textContent = hovered.code ? `${hovered.name} · ${count(areaCount(hovered.code))} 架`
      : state.layer === "planes" ? observationName(hovered) : `${count(hovered.count)} 架飞机`;
    popup.style.left = `${clamp(x + 12, 8, view.width - popup.offsetWidth - 8)}px`;
    popup.style.top = `${clamp(y - popup.offsetHeight - 12, 8, view.height - popup.offsetHeight - 8)}px`;
  }

  const pointerPosition = (event) => {
    const box = trafficCanvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };

  trafficCanvas.addEventListener("pointerdown", event => {
    if (event.button !== 0 || drag) return;
    drag = { x: event.clientX, y: event.clientY, lon: view.lon, lat: view.lat, pointer: event.pointerId, moved: false };
    trafficCanvas.setPointerCapture(event.pointerId);
  });
  trafficCanvas.addEventListener("pointermove", event => {
    if (!drag) {
      const [x, y] = pointerPosition(event);
      const country = state.layer === "countries" && countryAtPoint(x, y);
      showHover(country ? { item: country } : closest(x, y), x, y);
      return;
    }
    if (drag.pointer !== event.pointerId || (!view.globe && state.zoom <= 1)) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      trafficCanvas.classList.add("dragging");
      showHover(null);
    }
    const degreesPerPixel = view.globe ? 70 / view.radius : 1 / view.scale;
    moveCenter(drag.lon - dx * degreesPerPixel, drag.lat + dy * degreesPerPixel, view);
    schedule();
  });
  function endPointer(event) {
    if (!drag || drag.pointer !== event.pointerId) return;
    const moved = drag.moved || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 5;
    drag = null;
    trafficCanvas.classList.remove("dragging");
    if (event.type === "pointerup" && !moved) {
      const [x, y] = pointerPosition(event);
      const hit = closest(x, y);
      if (hit) updateDetails(hit.item);
      else {
        const area = countryAtPoint(x, y);
        if (area && (area.code !== "outside" || state.layer === "countries")) chooseCountry(area.code, false);
      }
    }
    updateControls();
    schedule();
  }
  trafficCanvas.addEventListener("pointerup", endPointer);
  trafficCanvas.addEventListener("pointercancel", endPointer);
  trafficCanvas.addEventListener("pointerleave", () => showHover(null));
  trafficCanvas.addEventListener("wheel", event => {
    if (!event.deltaY) return;
    event.preventDefault();
    showHover(null);
    zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, pointerPosition(event));
  }, { passive: false });
  trafficCanvas.addEventListener("keydown", event => {
    const arrows = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, 8], ArrowDown: [0, -8] };
    if (event.key === "Enter") {
      const hit = closest(view.cx, view.cy, true);
      if (hit) updateDetails(hit.item);
      else if (state.layer === "countries") chooseCountry(countryAtPoint(view.cx, view.cy).code, false);
    } else if (arrows[event.key] && (view.globe || state.zoom > 1)) {
      const [dx, dy] = arrows[event.key];
      const step = view.globe ? 1 / state.zoom : 5 / view.scale;
      moveCenter(view.lon + dx * step, view.lat + dy * step, view);
      updateControls();
      schedule();
    } else if (["+", "=", "-"].includes(event.key)) {
      zoomBy(event.key === "-" ? .8 : 1.25);
    } else return;
    event.preventDefault();
  });

  document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.view) {
      if (state.view !== button.dataset.view) {
        state.view = button.dataset.view;
        state.zoom = 1;
      }
    } else if (button.dataset.layer) {
      if (state.layer !== button.dataset.layer) {
        state.layer = button.dataset.layer;
        updateDetails(null);
        paintGeography();
      }
    } else if (button.dataset.country) {
      const code = button.dataset.country;
      if (code === "all") countrySearch.value = "";
      chooseCountry(code, true);
      if (button.parentElement === null) $(`#country-results [data-country="${code}"]`)?.focus();
    } else if (button.dataset.region || button.id === "reset") {
      region(button.dataset.region || "atlantic");
    } else if (button.dataset.band) {
      state.altitude = state.altitude === button.dataset.band ? "all" : button.dataset.band;
      refreshFilter();
    } else if (button.id === "zoom-in" || button.id === "zoom-out") {
      zoomBy(button.id === "zoom-in" ? 1.25 : .8);
    } else if (button.id === "selection-link") {
      const detail = selected ? $("#detail") : $("#country-panel");
      detail.scrollIntoView({ block: "center" });
      detail.focus({ preventScroll: true });
      return;
    } else if (button.hasAttribute("data-clear")) {
      updateDetails(null);
      trafficCanvas.focus();
    } else return;
    showHover(null);
    updateControls();
    schedule();
  });
  countrySearch.addEventListener("input", () => {
    countryResults.scrollTop = 0;
    renderCountries();
  });
  countrySearch.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    const firstMatch = countryResults.querySelector("button");
    if (firstMatch) chooseCountry(firstMatch.dataset.country, true);
  });
  $("#altitude").addEventListener("change", event => {
    state.altitude = event.target.value;
    showHover(null);
    refreshFilter();
  });

  const image = new Image();
  image.onload = () => {
    prepareTexture(image);
    textureReady = true;
    paintGeography();
    schedule();
  };
  image.src = $("#texture").textContent.trim();
  refreshFilter();
  new ResizeObserver(schedule).observe(stage);
  render();
})();
