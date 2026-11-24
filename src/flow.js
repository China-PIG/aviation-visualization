(async function () {
  "use strict";

  const nf = new Intl.NumberFormat("zh-CN");
  const fmt = value => nf.format(value);
  const json = id => JSON.parse(document.getElementById(id).textContent);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const smoothstep = (edge0, edge1, value) => {
    const k = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return k * k * (3 - 2 * k);
  };
  const TAU = Math.PI * 2;
  const OCEANS = [
    ["太平洋", -150, 5], ["大西洋", -30, 22], ["印度洋", 78, -22], ["北冰洋", 0, 80],
  ];
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TIER_LABEL = { city: "城市", country: "国家", continent: "洲" };
  const TOP_HEADING = { city: "流量最大的城市对", country: "流量最大的国家之间", continent: "流量最大的洲之间" };
  const CAPS = { city: 1100, country: 1500, continent: 80 };

  const DATA = json("flow-data");
  const WORLD = json("world-countries");
  const PLACES = json("world-cities");
  const CITIES = DATA.cities;
  const COUNTRIES = DATA.countries;
  const CONTINENTS = DATA.continents;
  const MONTHS = DATA.months;
  const DATES = DATA.dates;

  const countryByCode = new Map(COUNTRIES.map((country, index) => [country.code, index]));
  const continentByCode = new Map(CONTINENTS.map((continent, index) => [continent.code, index]));
  for (const country of COUNTRIES) country.ki = continentByCode.get(country.continent);
  for (const city of CITIES) {
    city.ci = countryByCode.get(city.country);
    city.ki = continentByCode.get(city.continent);
  }

  // Per-country extent, used when a country node is clicked.
  const countryBounds = COUNTRIES.map(() => null);
  for (const city of CITIES) {
    if (city.ci === undefined) continue;
    const box = countryBounds[city.ci] || (countryBounds[city.ci] = { lon0: 180, lon1: -180, lat0: 90, lat1: -90 });
    box.lon0 = Math.min(box.lon0, city.lon);
    box.lon1 = Math.max(box.lon1, city.lon);
    box.lat0 = Math.min(box.lat0, city.lat);
    box.lat1 = Math.max(box.lat1, city.lat);
  }
  for (let index = 0; index < COUNTRIES.length; index++) {
    if (!countryBounds[index]) {
      const { lon, lat } = COUNTRIES[index];
      countryBounds[index] = { lon0: lon, lon1: lon, lat0: lat, lat1: lat };
    }
  }

  // The flow rows ship as gzip+base64 (day, from, to, count) records.
  async function unpack(base64) {
    const binary = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const stream = new Blob([binary]).stream().pipeThrough(new DecompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    const view = new DataView(buffer);
    const stride = 7;
    const total = Math.floor(buffer.byteLength / stride);
    const day = new Uint8Array(total);
    const from = new Uint16Array(total);
    const to = new Uint16Array(total);
    const value = new Uint16Array(total);
    for (let index = 0, offset = 0; index < total; index++, offset += stride) {
      day[index] = view.getUint8(offset);
      from[index] = view.getUint16(offset + 1, true);
      to[index] = view.getUint16(offset + 3, true);
      value[index] = view.getUint16(offset + 5, true);
    }
    const byDay = DATES.map(() => []);
    for (let index = 0; index < total; index++) byDay[day[index]].push(index);
    return { total, from, to, value, byDay };
  }

  const flows = await unpack(DATA.flows);
  const links = await unpack(DATA.links);

  const state = { month: 0, day: 0, window: "day", region: -1, focus: -1, playing: false, camera: "world", view: "flat" };
  const trail = new Map();

  const stage = document.getElementById("stage");
  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d");
  const base = document.createElement("canvas");
  const bctx = base.getContext("2d");
  const popup = document.getElementById("popup");

  let W = 0;
  let H = 0;
  let dpr = 1;
  let baseDirty = true;
  let baseCam = { lon: 0, lat: 0, scale: 1 };
  const cam = { lon: 12, lat: 16, scale: 4 };
  let windowSpan = 1;
  let windowTotal = 0;
  let drag = null;
  let movedFar = false;

  const empty = count => ({ routes: [], nodes: new Array(count).fill(0) });
  const model = {
    city: empty(CITIES.length),
    country: empty(COUNTRIES.length),
    continent: empty(CONTINENTS.length),
  };

  const STOPS = [
    [0, [42, 82, 106]],
    [.34, [24, 140, 160]],
    [.68, [226, 158, 62]],
    [1, [255, 214, 102]],
  ];

  function colorAt(t) {
    for (let i = 1; i < STOPS.length; i++) {
      const [to, end] = STOPS[i];
      if (t <= to) {
        const [from, start] = STOPS[i - 1];
        const k = (t - from) / (to - from || 1);
        return [0, 1, 2].map(channel => Math.round(start[channel] + (end[channel] - start[channel]) * k));
      }
    }
    return STOPS[STOPS.length - 1][1];
  }
  const rgba = (color, alpha) => `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;

  // ---- projection ---------------------------------------------------------
  function project(lon, lat) {
    return [W / 2 + (lon - cam.lon) * cam.scale, H / 2 - (lat - cam.lat) * cam.scale];
  }

  function presets() {
    return {
      world: { lon: -10, lat: 18, scale: Math.max(W / 305, H / 170) },
      europe: { lon: 12, lat: 50, scale: Math.min(W / 60, H / 42) },
      america: { lon: -95, lat: 39, scale: Math.min(W / 80, H / 50) },
      asia: { lon: 110, lat: 28, scale: Math.min(W / 80, H / 52) },
    };
  }

  // 最小缩放：停在默认的全球视野，不允许再往外缩。
  function minScale() {
    return Math.max(3.2, presets().world.scale * .92);
  }

  function clampCamera() {
    cam.scale = clamp(cam.scale, minScale(), 170);
    if (view.t > .5) {
      // On the sphere the camera is a rotation, not a window onto a rectangle:
      // longitude wraps freely and latitude stops just short of the poles.
      cam.lon = ((cam.lon + 180) % 360 + 360) % 360 - 180;
      cam.lat = clamp(cam.lat, -85, 85);
      return;
    }
    const halfLon = Math.min(180, W / (2 * cam.scale));
    const halfLat = Math.min(89, H / (2 * cam.scale));
    cam.lon = halfLon >= 179 ? 0 : clamp(cam.lon, -180 + halfLon, 180 - halfLon);
    cam.lat = halfLat >= 88 ? 0 : clamp(cam.lat, -87 + halfLat, 87 - halfLat);
  }

  function resize() {
    const box = stage.getBoundingClientRect();
    W = Math.max(320, Math.round(box.width));
    H = Math.max(300, Math.round(box.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    base.width = Math.round(W * dpr);
    base.height = Math.round(H * dpr);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    baseDirty = true;
  }

  // ---- static basemap -----------------------------------------------------
  function drawBase() {
    baseDirty = false;
    baseCam = { lon: cam.lon, lat: cam.lat, scale: cam.scale };
    bctx.clearRect(0, 0, W, H);

    const step = cam.scale > 34 ? 5 : cam.scale > 14 ? 10 : cam.scale > 6 ? 20 : 30;
    bctx.beginPath();
    for (let lon = -180; lon <= 180; lon += step) {
      const [x] = project(lon, 0);
      if (x < -2 || x > W + 2) continue;
      bctx.moveTo(x, 0);
      bctx.lineTo(x, H);
    }
    for (let lat = -80; lat <= 80; lat += step) {
      const [, y] = project(0, lat);
      if (y < -2 || y > H + 2) continue;
      bctx.moveTo(0, y);
      bctx.lineTo(W, y);
    }
    bctx.strokeStyle = "#1a2331";
    bctx.lineWidth = .5;
    bctx.stroke();

    bctx.beginPath();
    for (const entry of WORLD) {
      for (const polygon of entry[1]) {
        for (const ring of polygon) {
          for (let i = 0; i < ring.length; i += 2) {
            const [x, y] = project(ring[i], ring[i + 1]);
            if (i === 0) bctx.moveTo(x, y);
            else bctx.lineTo(x, y);
          }
          bctx.closePath();
        }
      }
    }
    bctx.fillStyle = "#161f2a";
    bctx.strokeStyle = "#2d3a4c";
    bctx.lineWidth = .7;
    bctx.fill("evenodd");
    bctx.stroke();

    if (cam.scale < 110) {
      for (let pass = 0; pass < 2; pass++) {
        bctx.beginPath();
        for (const [lon, lat, rank] of PLACES) {
          if (pass === 0 ? rank > 3 : rank <= 3) continue;
          const [x, y] = project(lon, lat);
          if (x < -3 || x > W + 3 || y < -3 || y > H + 3) continue;
          bctx.moveTo(x + .9, y);
          bctx.arc(x, y, .9, 0, TAU);
        }
        bctx.fillStyle = pass === 0 ? "rgba(158,178,203,.30)" : "rgba(196,214,236,.5)";
        bctx.fill();
      }
    }
  }

  // ---- time window --------------------------------------------------------
  function range() {
    const month = MONTHS[state.month];
    if (state.window === "month") return [month.start, month.start + month.days - 1];
    const end = month.start + state.day;
    const length = state.window === "week" ? 7 : 1;
    return [Math.max(month.start, end - length + 1), end];
  }

  function keepTier(tier, from, to) {
    if (state.focus !== -1) {
      if (tier === "city") return CITIES[from].ci === state.focus && CITIES[to].ci === state.focus;
      if (tier === "country") return from === state.focus || to === state.focus;
    }
    if (state.region === -1) return true;
    if (tier === "city") return CITIES[from].ki === state.region || CITIES[to].ki === state.region;
    if (tier === "country") return COUNTRIES[from].ki === state.region || COUNTRIES[to].ki === state.region;
    return from === state.region || to === state.region;
  }

  function memoryFor(tier, key, particles) {
    const slot = `${tier}:${key}`;
    let memory = trail.get(slot);
    if (!memory || memory.phases.length !== particles) {
      const phases = new Float64Array(particles);
      for (let i = 0; i < particles; i++) phases[i] = i / particles;
      memory = { phases, progress: memory ? memory.progress : Math.random() };
      trail.set(slot, memory);
    }
    return memory;
  }

  function buildRoutes(sums, nodeCount, tier) {
    let peak = 1;
    for (const value of sums.values()) if (value > peak) peak = value;
    const routes = [];
    const nodes = new Array(nodeCount).fill(0);
    for (const [key, value] of sums) {
      const from = Math.floor(key / nodeCount);
      const to = key % nodeCount;
      nodes[from] += value;
      nodes[to] += value;
      if (!keepTier(tier, from, to)) continue;
      const weight = Math.pow(value / peak, tier === "city" ? .42 : .32);
      const particles = Math.max(1, Math.round((tier === "continent" ? 2 : 1) + (tier === "city" ? 7 : 5) * weight));
      const memory = memoryFor(tier, key, particles);
      routes.push({
        from, to, value, weight,
        dir: from < to ? 1 : -1,
        speed: .1 + .55 * weight,
        color: colorAt(weight),
        width: .7 + (tier === "city" ? 2.6 : 3.2) * weight,
        alpha: .1 + .5 * weight,
        phases: memory.phases,
        progress: memory.progress,
      });
    }
    routes.sort((a, b) => b.value - a.value);
    return { routes, nodes };
  }

  function aggregate() {
    const [start, end] = range();
    windowSpan = end - start + 1;
    const citySums = new Map();
    const countrySums = new Map();
    for (let day = start; day <= end; day++) {
      for (const index of flows.byDay[day]) {
        const key = flows.from[index] * CITIES.length + flows.to[index];
        citySums.set(key, (citySums.get(key) || 0) + flows.value[index]);
      }
      for (const index of links.byDay[day]) {
        const key = links.from[index] * COUNTRIES.length + links.to[index];
        countrySums.set(key, (countrySums.get(key) || 0) + links.value[index]);
      }
    }
    const continentSums = new Map();
    for (const [key, value] of countrySums) {
      const from = Math.floor(key / COUNTRIES.length);
      const to = key % COUNTRIES.length;
      const a = COUNTRIES[from].ki;
      const b = COUNTRIES[to].ki;
      if (a === undefined || b === undefined) continue;
      const ck = a * CONTINENTS.length + b;
      continentSums.set(ck, (continentSums.get(ck) || 0) + value);
    }
    model.city = buildRoutes(citySums, CITIES.length, "city");
    model.country = buildRoutes(countrySums, COUNTRIES.length, "country");
    model.continent = buildRoutes(continentSums, CONTINENTS.length, "continent");
    windowTotal = 0;
    for (const value of countrySums.values()) windowTotal += value;
    render();
  }

  // ---- tier geometry ------------------------------------------------------
  function tierPoint(tier, index, weights) {
    if (tier === "continent") return project(CONTINENTS[index].lon, CONTINENTS[index].lat);
    if (tier === "country") {
      const home = CONTINENTS[COUNTRIES[index].ki];
      const [ox, oy] = project(COUNTRIES[index].lon, COUNTRIES[index].lat);
      if (!home) return [ox, oy];
      const [cx, cy] = project(home.lon, home.lat);
      const keep = 1 - weights.continent;
      return [cx + (ox - cx) * keep, cy + (oy - cy) * keep];
    }
    const city = CITIES[index];
    const [ox, oy] = project(city.lon, city.lat);
    const country = COUNTRIES[city.ci] || { lon: city.lon, lat: city.lat };
    const continent = CONTINENTS[city.ki] || { lon: city.lon, lat: city.lat };
    const [gx, gy] = project(country.lon, country.lat);
    const [cx, cy] = project(continent.lon, continent.lat);
    return [
      ox * weights.city + gx * weights.country + cx * weights.continent,
      oy * weights.city + gy * weights.country + cy * weights.continent,
    ];
  }

  function tierWeights() {
    const city = smoothstep(8, 12, cam.scale);
    const band = smoothstep(2.6, 3.4, cam.scale);
    return { city, country: (1 - city) * band, continent: (1 - city) * (1 - band) };
  }

  function dominantTier(weights) {
    if (weights.city >= weights.country && weights.city >= weights.continent) return "city";
    return weights.country >= weights.continent ? "country" : "continent";
  }

  function routeGeometry(tier, route, weights) {
    const [x0, y0] = tierPoint(tier, route.from, weights);
    const [x1, y1] = tierPoint(tier, route.to, weights);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy) || 1;
    const bend = Math.min(200, Math.max(5, length * .16)) * route.dir;
    return { x0, y0, x1, y1, length, cx: (x0 + x1) / 2 - dy / length * bend, cy: (y0 + y1) / 2 + dx / length * bend };
  }

  // ---- drawing ------------------------------------------------------------
  function drawRoutes(tier, alpha, weights, dt) {
    const routes = model[tier].routes;
    for (let index = 0; index < routes.length && index < CAPS[tier]; index++) {
      const route = routes[index];
      const { x0, y0, x1, y1, cx, cy, length } = routeGeometry(tier, route, weights);
      if (length < 2.5) continue;
      if (Math.max(x0, x1) < -60 || Math.min(x0, x1) > W + 60) continue;
      if (Math.max(y0, y1) < -60 || Math.min(y0, y1) > H + 60) continue;

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(cx, cy, x1, y1);
      ctx.strokeStyle = rgba(route.color, route.alpha * alpha * .9);
      ctx.lineWidth = route.width;
      ctx.stroke();

      if (!REDUCED) route.progress = (route.progress + route.speed * dt) % 1;
      const size = (1.1 + 1.7 * route.weight) * (tier === "city" ? 1 : 1.15);
      for (let i = 0; i < route.phases.length; i++) {
        const t = (route.progress + route.phases[i]) % 1;
        const u = 1 - t;
        const px = u * u * x0 + 2 * u * t * cx + t * t * x1;
        const py = u * u * y0 + 2 * u * t * cy + t * t * y1;
        const fade = Math.min(1, Math.sin(Math.PI * t) * 1.7);
        ctx.beginPath();
        ctx.arc(px, py, size * 2.4, 0, TAU);
        ctx.fillStyle = rgba(route.color, .12 * fade * alpha);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, size, 0, TAU);
        ctx.fillStyle = rgba(route.color, (.5 + .45 * fade) * alpha);
        ctx.fill();
      }
    }
  }

  // Node size and shade both encode the same quantity (in + out flights in the
  // current window): a compressed area scale for the radius and a dark-bronze
  // to bright-gold ramp so the ranking stays readable.
  function nodeStyle(tier, traffic, max) {
    const t = Math.pow(Math.min(1, traffic / Math.max(1, max)), .45);
    const radius = tier === "continent"
      ? 5 + 12 * t
      : tier === "country"
        ? 2.6 + 10.5 * t
        : (1.8 + 6 * t) * clamp(cam.scale / 16, .55, 1.1);
    const color = [
      Math.round(122 + (255 - 122) * t),
      Math.round(98 + (214 - 98) * t),
      Math.round(48 + (102 - 48) * t),
    ];
    return { radius, color };
  }

  function nodeMax(tier) {
    let max = 1;
    for (const value of model[tier].nodes) if (value > max) max = value;
    return max;
  }

  function tierName(tier, index) {
    if (tier === "city") return CITIES[index].name;
    if (tier === "country") return COUNTRIES[index].name;
    return CONTINENTS[index].name;
  }

  function tierActive(tier, index) {
    if (state.region === -1) return true;
    if (tier === "city") return CITIES[index].ki === state.region;
    if (tier === "country") return COUNTRIES[index].ki === state.region;
    return index === state.region;
  }

  function drawNodes(tier, alpha, weights, labels) {
    const { nodes } = model[tier];
    const max = nodeMax(tier);
    for (let index = 0; index < nodes.length; index++) {
      const [x, y] = tierPoint(tier, index, weights);
      if (x < -40 || x > W + 40 || y < -40 || y > H + 40) continue;
      const active = tierActive(tier, index);
      const { radius, color } = nodeStyle(tier, nodes[index], max);
      if (tier === "continent" && tierWeights().city < .6) {
        labels.push({ tier, index, x, y, value: nodes[index], active, radius: 0, big: true });
        continue;
      }
      if (radius < 1.6) continue;
      ctx.beginPath();
      ctx.arc(x, y, radius + (tier === "city" ? 3 : 4), 0, TAU);
      ctx.fillStyle = rgba([255, 203, 73], (active ? .12 : .05) * alpha);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, TAU);
      ctx.fillStyle = active ? rgba(color, alpha) : rgba([89, 99, 111], alpha * .8);
      ctx.fill();
      if (tier === "continent") {
        ctx.strokeStyle = rgba([11, 16, 23], alpha * .8);
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      labels.push({ tier, index, x, y, value: nodes[index], active, radius });
    }
  }

  function drawLabels(labels, alpha, continentsOnly = false) {
    const boxes = [];
    const fits = (x0, y0, x1, y1) => {
      for (const box of boxes) {
        if (x0 < box[2] && x1 > box[0] && y0 < box[3] && y1 > box[1]) return false;
      }
      return true;
    };
    const limit = cam.scale > 9 ? 70 : cam.scale > 4 ? 58 : cam.scale > 3 ? 42 : 24;
    ctx.lineJoin = "round";
    ctx.textAlign = "left";
    let drawn = 0;
    for (const item of labels) {
      if (drawn >= limit) break;
      if (continentsOnly && item.tier !== "continent") continue;
      const text = tierName(item.tier, item.index);
      ctx.font = item.tier === "continent"
        ? (item.big ? '600 17px system-ui, "Microsoft YaHei", sans-serif'
                    : '600 13px system-ui, "Microsoft YaHei", sans-serif')
        : item.tier === "country"
          ? '600 11px system-ui, "Microsoft YaHei", sans-serif'
          : '11px system-ui, "Microsoft YaHei", sans-serif';
      const width = ctx.measureText(text).width;
      const x0 = item.x + item.radius + 5;
      const y0 = item.y - 12;
      if (!fits(x0 - 2, y0, x0 + width + 2, y0 + 15)) continue;
      boxes.push([x0 - 2, y0, x0 + width + 2, y0 + 15]);
      drawn += 1;
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = rgba([9, 13, 19], .85 * alpha);
      ctx.strokeText(text, x0, item.y + 4);
      ctx.fillStyle = item.active ? rgba([236, 241, 248], alpha) : rgba([125, 135, 150], alpha * .9);
      ctx.fillText(text, x0, item.y + 4);
    }
  }

  // ---- globe view ---------------------------------------------------------
  // `view.t` morphs between the flat map (0) and the sphere (1). Both scenes
  // are drawn with complementary opacity, so the switch reads as a rotation
  // of the same picture rather than a hard cut.
  const view = { t: 0, target: 0 };
  const DEG = Math.PI / 180;

  function globeRadius() {
    const base = Math.min(W, H) * .42;
    const zoom = clamp(cam.scale / presets().world.scale, .55, 4.5);
    return base * zoom * (0.7 + 0.3 * view.t);
  }

  function projectGlobe(lon, lat, radius) {
    const phi = lat * DEG;
    const lambda = (lon - cam.lon) * DEG;
    const x = Math.cos(phi) * Math.sin(lambda);
    const y = Math.sin(phi);
    const z = Math.cos(phi) * Math.cos(lambda);
    const tilt = cam.lat * DEG;
    const rotated = y * Math.cos(tilt) - z * Math.sin(tilt);
    const depth = y * Math.sin(tilt) + z * Math.cos(tilt);
    return [W / 2 + x * radius, H / 2 - rotated * radius, depth];
  }

  function drawGlobeBase(alpha, radius) {
    const centre = [W / 2, H / 2];
    ctx.save();
    ctx.globalAlpha = alpha;
    const shade = ctx.createRadialGradient(centre[0] - radius * .35, centre[1] - radius * .38, radius * .1, centre[0], centre[1], radius * 1.02);
    shade.addColorStop(0, "#1b2736");
    shade.addColorStop(.72, "#111a26");
    shade.addColorStop(1, "#0a1018");
    ctx.beginPath();
    ctx.arc(centre[0], centre[1], radius, 0, TAU);
    ctx.fillStyle = shade;
    ctx.fill();
    ctx.strokeStyle = "rgba(90,120,150,.45)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    for (let lon = -180; lon < 180; lon += 30) {
      let started = false;
      for (let lat = -90; lat <= 90; lat += 4) {
        const [x, y, z] = projectGlobe(lon, lat, radius);
        if (z <= 0) { started = false; continue; }
        if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
      }
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      let started = false;
      for (let lon = -180; lon <= 180; lon += 4) {
        const [x, y, z] = projectGlobe(lon, lat, radius);
        if (z <= 0) { started = false; continue; }
        if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
      }
    }
    ctx.strokeStyle = "rgba(52,74,98,.55)";
    ctx.lineWidth = .5;
    ctx.stroke();

    ctx.beginPath();
    for (const entry of WORLD) {
      for (const polygon of entry[1]) {
        for (const ring of polygon) {
          let started = false;
          for (let i = 0; i < ring.length; i += 6) {
            const [x, y, z] = projectGlobe(ring[i], ring[i + 1], radius);
            if (z <= 0) { started = false; continue; }
            if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
          }
        }
      }
    }
    ctx.fillStyle = "#1d2a38";
    ctx.strokeStyle = "#33475c";
    ctx.lineWidth = .6;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function globePointOf(tier, index) {
    if (tier === "continent") return CONTINENTS[index];
    if (tier === "country") return COUNTRIES[index];
    return CITIES[index];
  }

  function drawGlobeFlows(weights, radius, alpha, dt, farOut = false) {
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const tier of ["continent", "country", "city"]) {
      if (weights[tier] <= .01) continue;
      const routes = model[tier].routes;
      for (let i = 0; i < routes.length && i < CAPS[tier]; i++) {
        const route = routes[i];
        const a = globePointOf(tier, route.from);
        const b = globePointOf(tier, route.to);
        const [x0, y0, z0] = projectGlobe(a.lon, a.lat, radius);
        const [x1, y1, z1] = projectGlobe(b.lon, b.lat, radius);
        if (z0 <= 0 || z1 <= 0) continue;
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        const length = Math.hypot(x1 - x0, y1 - y0) || 1;
        const bend = Math.min(120, length * .18) * route.dir;
        const cx = mx - (y1 - y0) / length * bend;
        const cy = my + (x1 - x0) / length * bend;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(cx, cy, x1, y1);
        ctx.strokeStyle = rgba(route.color, route.alpha * weights[tier] * .95);
        ctx.lineWidth = route.width;
        ctx.stroke();
        if (!REDUCED) route.progress = (route.progress + route.speed * dt) % 1;
        const size = 1.1 + 1.6 * route.weight;
        for (let p = 0; p < route.phases.length; p += 1) {
          const t = (route.progress + route.phases[p]) % 1;
          const u = 1 - t;
          const px = u * u * x0 + 2 * u * t * cx + t * t * x1;
          const py = u * u * y0 + 2 * u * t * cy + t * t * y1;
          const fade = Math.min(1, Math.sin(Math.PI * t) * 1.7);
          ctx.beginPath();
          ctx.arc(px, py, size, 0, TAU);
          ctx.fillStyle = rgba(route.color, (.3 + .6 * fade) * weights[tier]);
          ctx.fill();
        }
      }
    }
    const labels = [];
    for (const tier of ["continent", "country", "city"]) {
      if (weights[tier] <= .01) continue;
      const nodes = model[tier].nodes;
      const max = nodeMax(tier);
      for (let index = 0; index < nodes.length; index++) {
        const point = globePointOf(tier, index);
        const [x, y, z] = projectGlobe(point.lon, point.lat, radius);
        if (z <= 0.02) continue;
        const active = tierActive(tier, index);
        const style = nodeStyle(tier, nodes[index], max);
        const radiusNode = style.radius * (tier === "city" ? 1 : 1.1);
        if (radiusNode < 1.4) continue;
        const noBubble = farOut || tier === "country";
        if (!noBubble) {
          ctx.beginPath();
          ctx.arc(x, y, radiusNode, 0, TAU);
          ctx.fillStyle = active ? rgba(style.color, .95) : rgba([89, 99, 111], .7);
          ctx.fill();
        }
        if (!farOut) labels.push({ tier, index, x, y, value: nodes[index], active, radius: radiusNode });
      }
    }
    labels.sort((a, b) => b.value - a.value);
    drawLabels(labels, alpha);
    if (farOut) {
      // 缩小时把真实的国家对航线淡显铺底：数据本身就有上千条，
      // 之前只剩 5 个洲的聚合线，才会显得空。
      for (let i = 0; i < model.country.routes.length && i < CAPS.country; i += 1) {
        const route = model.country.routes[i];
        if (route.from === route.to) continue;
        const from = COUNTRIES[route.from];
        const to = COUNTRIES[route.to];
        const [x0, y0, z0] = projectGlobe(from.lon, from.lat, radius);
        const [x1, y1, z1] = projectGlobe(to.lon, to.lat, radius);
        if (z0 <= 0.1 || z1 <= 0.1) continue;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo((x0 + x1) / 2, (y0 + y1) / 2 - 30, x1, y1);
        ctx.strokeStyle = rgba(route.color, .18);
        ctx.lineWidth = .7 + 1.4 * route.weight;
        ctx.stroke();
      }
      ctx.font = '600 15px system-ui, "Microsoft YaHei", sans-serif';
      ctx.textAlign = "center";
      for (const continent of CONTINENTS) {
        const [x, y, z] = projectGlobe(continent.lon, continent.lat, radius);
        if (z <= 0.12) continue;
        ctx.fillStyle = rgba([233, 239, 248], .9 * alpha);
        ctx.fillText(continent.name, x, y);
      }
      ctx.font = '500 12px system-ui, "Microsoft YaHei", sans-serif';
      for (const [name, lon, lat] of OCEANS) {
        const [x, y, z] = projectGlobe(lon, lat, radius);
        if (z <= 0.1) continue;
        ctx.fillStyle = rgba([176, 196, 222], .45 * alpha);
        ctx.fillText(name, x, y);
      }
      ctx.textAlign = "left";
    }
    ctx.restore();
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(.06, (now - last) / 1000);
    last = now;
    if (Math.abs(view.t - view.target) > .01) {
      view.t += (view.target - view.t) * Math.min(1, dt * 9);
      if (Math.abs(view.t - view.target) <= .01) view.t = view.target;
    }
    const weights = tierWeights();
    const farOut = weights.city < .6;
    ctx.clearRect(0, 0, W, H);

    const flatAlpha = Math.max(0, 1 - view.t * 2.2);
    if (flatAlpha > .01) {
      ctx.save();
      ctx.globalAlpha = flatAlpha;
      if (baseDirty) drawBase();
      if (baseCam.scale === cam.scale) {
        ctx.drawImage(base, -(cam.lon - baseCam.lon) * cam.scale, (cam.lat - baseCam.lat) * cam.scale, W, H);
      } else {
        drawBase();
        ctx.drawImage(base, 0, 0, W, H);
      }
      const labels = [];
      for (const tier of ["continent", "country", "city"]) {
        if (weights[tier] <= .01) continue;
        drawRoutes(tier, weights[tier], weights, dt);
      }
      for (const tier of ["continent", "country", "city"]) {
        if (weights[tier] <= .01) continue;
        drawNodes(tier, weights[tier], weights, labels);
      }
      labels.sort((a, b) => b.value - a.value);
      drawLabels(labels, 1);
      ctx.restore();
    }

    if (view.t > .005) {
      const radius = globeRadius();
      drawGlobeBase(view.t, radius);
      drawGlobeFlows(weights, radius, view.t, dt, farOut);
    }
    requestAnimationFrame(frame);
  }

  // ---- sidebar and controls ----------------------------------------------
  let calendarOpen = false;

  // Month grid in the top-right corner; a blue dot marks days that have data.
  function renderCalendar() {
    const month = MONTHS[state.month];
    const first = new Date(`${DATES[month.start]}T00:00:00Z`);
    const lead = (first.getUTCDay() + 6) % 7;
    let cells = "";
    for (let blank = 0; blank < lead; blank += 1) cells += '<button class="empty" tabindex="-1"></button>';
    for (let day = 0; day < month.days; day += 1) {
      const global = month.start + day;
      const has = links.byDay[global].length > 0;
      cells += `<button type="button" data-cal="${day}" class="${has ? "has-data" : "nodata"}"`
        + ` aria-current="${day === state.day}"${has ? "" : " disabled"}>${day + 1}`
        + `${has ? '<i class="calendar-dot"></i>' : ""}</button>`;
    }
    const heads = ["一", "二", "三", "四", "五", "六", "日"].map(name => `<span>${name}</span>`).join("");
    const host = document.getElementById("calendar");
    host.classList.toggle("collapsed", !calendarOpen);
    host.innerHTML =
      `<div class="calendar-head">
         <button type="button" data-cal-nav="-1" aria-label="上个月"${state.month === 0 ? " disabled" : ""}>‹</button>
         <b>${month.label}</b>
         <button type="button" data-cal-nav="1" aria-label="下个月"${state.month === MONTHS.length - 1 ? " disabled" : ""}>›</button>
         <button type="button" data-cal-toggle aria-label="${calendarOpen ? "折叠日历" : "展开日历"}">${calendarOpen ? "−" : "+"}</button>
       </div>
       <div class="calendar-grid">${heads}${cells}</div>`;
  }

  const stamp = iso => iso.replaceAll("-", ".");
  const windowLabel = () => state.window === "day" ? "当日" : state.window === "week" ? "近 7 日" : "整月";

  function topLabel(tier, route) {
    if (tier === "city") return `${CITIES[route.from].name} → ${CITIES[route.to].name}`;
    if (tier === "country") return `${COUNTRIES[route.from].name} → ${COUNTRIES[route.to].name}`;
    return route.from === route.to ? `${CONTINENTS[route.from].name}境内` : `${CONTINENTS[route.from].name} → ${CONTINENTS[route.to].name}`;
  }

  function render() {
    const [start, end] = range();
    const month = MONTHS[state.month];
    const weights = tierWeights();
    const tier = dominantTier(weights);

    document.getElementById("total").textContent = fmt(windowTotal);
    document.getElementById("daily").textContent = fmt(Math.round(windowTotal / windowSpan));
    document.getElementById("pairs").textContent = fmt(model[tier].routes.length);
    document.getElementById("tier").textContent = TIER_LABEL[tier];

    const top = model[tier].routes.slice(0, 8);
    const topPeak = top[0] ? top[0].value : 1;
    document.getElementById("top-heading").textContent = TOP_HEADING[tier];
    document.getElementById("top-routes").innerHTML = top.length
      ? top.map(route => `<li>
          <span class="line"><span>${topLabel(tier, route)}</span><b>${fmt(route.value)}</b></span>
          <i><b style="width:${route.value / topPeak * 100}%"></b></i>
        </li>`).join("")
      : '<li><span class="line"><span>当前筛选没有航线</span><b>0</b></span></li>';

    const regionPeak = Math.max(1, ...model.continent.nodes);
      document.getElementById("region-bars").innerHTML = CONTINENTS.map((continent, index) => `
        <button type="button" data-region="${index}" aria-pressed="${state.region === index}">
          <span><span>${continent.name}</span><b>${fmt(model.continent.nodes[index])}</b></span>
          <i><b style="width:${model.continent.nodes[index] / regionPeak * 100}%"></b></i>
        </button>`).join("");

    const chinaRegions = DATA.chinaRegions;
    if (chinaRegions) {
      const totals = new Array(chinaRegions.length).fill(0);
      for (let day = start; day <= end; day += 1) {
        for (const index of flows.byDay[day]) {
          const from = CITIES[flows.from[index]];
          const to = CITIES[flows.to[index]];
          if (from.country !== "CN" || to.country !== "CN") continue;
          const value = flows.value[index];
          if (from.region >= 0) totals[from.region] += value;
          if (to.region >= 0) totals[to.region] += value;
        }
      }
      const chinaPeak = Math.max(1, ...totals);
      document.getElementById("china-bars").innerHTML = chinaRegions.map((name, index) => `
        <div class="bar-row">
          <span><span>${name}</span><b>${fmt(totals[index])}</b></span>
          <i><b style="width:${totals[index] / chinaPeak * 100}%"></b></i>
        </div>`).join("");
    }

    document.getElementById("period-date").textContent = windowSpan === 1
      ? stamp(DATES[end])
      : `${stamp(DATES[start])} — ${stamp(DATES[end])}`;
    document.getElementById("period-note").textContent = `${windowLabel()} · ${month.label}`;
    document.getElementById("day-readout").textContent = state.window === "day"
      ? `${stamp(DATES[month.start + state.day]).slice(5)} · ${fmt(windowTotal)} 班`
      : `${windowLabel()} · ${fmt(windowTotal)} 班`;
    document.getElementById("legend").innerHTML =
      '<span>流量小</span><i></i><span>流量大</span><em>颜色 / 线宽 / 流速</em><em>球的大小与深浅 = 进出港班次</em>';

    document.querySelectorAll("[data-month]").forEach(button =>
      button.setAttribute("aria-pressed", Number(button.dataset.month) === state.month));

    const dayValues = Array.from({ length: month.days }, (_, offset) =>
      links.byDay[month.start + offset].reduce((sum, index) => sum + links.value[index], 0));
    const low = Math.min(...dayValues);
    const high = Math.max(...dayValues);
    const height = value => 26 + 74 * (value - low) / Math.max(1, high - low);
    document.getElementById("days").innerHTML = dayValues.map((value, offset) => {
      const inside = month.start + offset >= start && month.start + offset <= end;
      return `<button type="button" data-day="${offset}" aria-pressed="${inside}"${offset === state.day ? ' aria-current="true"' : ""}
        title="${DATES[month.start + offset]} · ${fmt(value)} 班"><i style="height:${height(value).toFixed(1)}%"></i></button>`;
    }).join("");

    document.getElementById("map-empty").hidden = model.city.routes.length > 0 || windowTotal > 0;
    document.getElementById("map-scale").textContent =
      `层级 · ${TIER_LABEL[tier]}${state.focus >= 0 ? " · " + COUNTRIES[state.focus].name : ""}`;
    document.getElementById("stage").dataset.tier = tier;
    renderCalendar();
  }

  function syncToolbar() {
    document.querySelectorAll("[data-window]").forEach(el => el.setAttribute("aria-pressed", el.dataset.window === state.window));
    document.querySelectorAll("[data-camera]").forEach(el => el.setAttribute("aria-pressed", el.dataset.camera === state.camera));
    document.querySelectorAll("[data-region]").forEach(el => el.setAttribute("aria-pressed", Number(el.dataset.region) === state.region));
  }

  // ---- picking ------------------------------------------------------------
  function pick(x, y, weights) {
    const tier = dominantTier(weights);
    let best = null;
    let bestDistance = 20;
    const { nodes } = model[tier];
    for (let index = 0; index < nodes.length; index++) {
      const [px, py] = tierPoint(tier, index, weights);
      const distance = Math.hypot(px - x, py - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { kind: "node", tier, index };
      }
    }
    if (best) return best;
    bestDistance = 6;
    for (let i = 0; i < model[tier].routes.length && i < CAPS[tier]; i++) {
      const route = model[tier].routes[i];
      const { x0, y0, x1, y1, cx, cy } = routeGeometry(tier, route, weights);
      for (let step = 1; step < 14; step++) {
        const t = step / 14;
        const u = 1 - t;
        const px = u * u * x0 + 2 * u * t * cx + t * t * x1;
        const py = u * u * y0 + 2 * u * t * cy + t * t * y1;
        const distance = Math.hypot(px - x, py - y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { kind: "route", tier, route };
        }
      }
    }
    return best;
  }

  function showPopup(target, x, y) {
    if (!target) {
      popup.hidden = true;
      return;
    }
    if (target.kind === "route") {
      popup.innerHTML = `<b>${topLabel(target.tier, target.route)}</b>
        <span>${fmt(target.route.value)} 班 · 日均 ${(target.route.value / windowSpan).toFixed(1)} 班</span>`;
    } else if (target.tier === "city") {
      const city = CITIES[target.index];
      let out = 0;
      let incoming = 0;
      for (const route of model.city.routes) {
        if (route.from === target.index) out += route.value;
        if (route.to === target.index) incoming += route.value;
      }
      popup.innerHTML = `<b>${city.name}</b>
        <span>${COUNTRIES[city.ci] ? COUNTRIES[city.ci].name : ""} · 出港 ${fmt(out)} · 进港 ${fmt(incoming)}</span>`;
    } else if (target.tier === "country") {
      const country = COUNTRIES[target.index];
      popup.innerHTML = `<b>${country.name}</b>
        <span>相关流量 ${fmt(model.country.nodes[target.index])} 班 · 点击筛选</span>`;
    } else {
      const continent = CONTINENTS[target.index];
      popup.innerHTML = `<b>${continent.name}</b><span>洲内与洲际流量 ${fmt(model.continent.nodes[target.index])} 班</span>`;
    }
    popup.hidden = false;
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    popup.style.left = `${clamp(x + 14, 4, Math.max(4, W - width - 6))}px`;
    popup.style.top = `${clamp(y - height - 12, 4, Math.max(4, H - height - 6))}px`;
  }

  // ---- camera -------------------------------------------------------------
  function animateTo(target, duration = 620) {
    const from = { lon: cam.lon, lat: cam.lat, scale: cam.scale };
    const begin = performance.now();
    const span = REDUCED ? 0 : duration;
    baseDirty = true;
    function step(now) {
      const k = span ? Math.min(1, (now - begin) / span) : 1;
      const ease = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      cam.lon = from.lon + (target.lon - from.lon) * ease;
      cam.lat = from.lat + (target.lat - from.lat) * ease;
      cam.scale = from.scale * Math.pow(target.scale / from.scale, ease);
      clampCamera();
      if (k < 1) requestAnimationFrame(step);
      else {
        baseDirty = true;
        render();
      }
    }
    requestAnimationFrame(step);
  }

  function flyTo(name) {
    const target = presets()[name];
    if (!target) return;
    state.camera = name;
    syncToolbar();
    animateTo(target);
  }

  // Clicking a country dives into its cities. Countries too wide to frame at
  // city zoom fall back to their busiest city in the current window.
  function zoomToCountry(index) {
    const box = countryBounds[index];
    if (!box) return;
    const spanLon = Math.max(box.lon1 - box.lon0, .6);
    const spanLat = Math.max(box.lat1 - box.lat0, .6);
    const fit = Math.min(W / (spanLon * 1.6), H / (spanLat * 1.9));
    let target;
    if (fit >= 9) {
      target = { lon: (box.lon0 + box.lon1) / 2, lat: (box.lat0 + box.lat1) / 2, scale: Math.min(32, fit) };
    } else {
      let best = -1;
      let bestValue = -1;
      for (let city = 0; city < CITIES.length; city++) {
        if (CITIES[city].ci !== index) continue;
        const value = model.city.nodes[city] || 0;
        if (value > bestValue) {
          bestValue = value;
          best = city;
        }
      }
      const focus = best >= 0 ? CITIES[best] : COUNTRIES[index];
      target = { lon: focus.lon, lat: focus.lat, scale: 12 };
    }
    let cityCount = 0;
    for (const city of CITIES) if (city.ci === index) cityCount += 1;
    state.focus = cityCount >= 2 && state.focus !== index ? index : -1;
    const code = state.focus >= 0 ? "?country=" + COUNTRIES[state.focus].code : location.pathname.split("/").pop();
    if (state.focus >= 0) window.history.replaceState(null, "", `?country=${COUNTRIES[state.focus].code}`);
    else window.history.replaceState(null, "", location.pathname.split("/").pop());
    state.camera = "";
    syncToolbar();
    aggregate();
    if (model.country.routes.length === 0) {
      state.focus = -1;
      window.history.replaceState(null, "", location.pathname.split("/").pop());
      aggregate();
    }
    animateTo(target, 760);
  }

  function zoomBy(factor, anchorX, anchorY) {
    const before = cam.scale;
    const lon = cam.lon + ((anchorX ?? W / 2) - W / 2) / before;
    const lat = cam.lat - ((anchorY ?? H / 2) - H / 2) / before;
    cam.scale = clamp(cam.scale * factor, minScale(), 170);
    if (anchorX === undefined) return;
    cam.lon = lon - ((anchorX ?? W / 2) - W / 2) / cam.scale;
    cam.lat = lat + ((anchorY ?? H / 2) - H / 2) / cam.scale;
    clampCamera();
  }

  function manualCamera() {
    if (state.camera !== "") state.camera = "";
    syncToolbar();
  }

  // ---- events -------------------------------------------------------------
  const mapPanel = stage.closest(".map");
  const fullscreenButton = document.getElementById("map-fullscreen");
  let viewportFullscreen = false;
  let restoreScroll = null;

  function syncFullscreen() {
    const active = viewportFullscreen || document.fullscreenElement === mapPanel;
    const root = document.documentElement;
    if (root.classList.contains("map-fullscreen") === active) return;
    root.classList.toggle("map-fullscreen", active);
    fullscreenButton.textContent = active ? "退出全屏" : "全屏";
    popup.hidden = true;
    fullscreenButton.focus({ preventScroll: true });
    if (!active && restoreScroll) {
      window.scrollTo(...restoreScroll);
      restoreScroll = null;
    }
  }

  fullscreenButton.addEventListener("click", async () => {
    if (document.fullscreenElement === mapPanel) {
      await document.exitFullscreen().catch(syncFullscreen);
      return;
    }
    if (viewportFullscreen) {
      viewportFullscreen = false;
      syncFullscreen();
      return;
    }
    if (restoreScroll) return;
    restoreScroll = [window.scrollX, window.scrollY];
    if (document.fullscreenEnabled && mapPanel.requestFullscreen) {
      try {
        await mapPanel.requestFullscreen();
        return;
      } catch {
        // Embedded previews can deny native fullscreen.
      }
    }
    viewportFullscreen = true;
    syncFullscreen();
  });
  document.addEventListener("fullscreenchange", syncFullscreen);
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !viewportFullscreen) return;
    viewportFullscreen = false;
    syncFullscreen();
  });

  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    zoomBy(Math.exp(-event.deltaY * .0016), event.offsetX, event.offsetY);
    manualCamera();
    baseDirty = true;
    render();
  }, { passive: false });

  canvas.addEventListener("pointerdown", event => {
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("dragging");
    drag = { x: event.offsetX, y: event.offsetY, lon: cam.lon, lat: cam.lat };
    movedFar = false;
    popup.hidden = true;
  });

  canvas.addEventListener("pointermove", event => {
    if (drag) {
      if (Math.hypot(event.offsetX - drag.x, event.offsetY - drag.y) > 5) movedFar = true;
      const dragScale = view.t > .5 ? globeRadius() * Math.PI / 180 : cam.scale;
      cam.lon = drag.lon - (event.offsetX - drag.x) / dragScale;
      cam.lat = drag.lat + (event.offsetY - drag.y) / dragScale;
      clampCamera();
      manualCamera();
      return;
    }
    const target = pick(event.offsetX, event.offsetY, tierWeights());
    canvas.style.cursor = target ? (target.kind === "route" ? "crosshair" : "pointer") : "";
    showPopup(target, event.offsetX, event.offsetY);
  });

  function endDrag(event) {
    if (!drag) return;
    drag = null;
    canvas.classList.remove("dragging");
    baseDirty = true;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    render();
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => { popup.hidden = true; });

  canvas.addEventListener("click", event => {
    if (movedFar) {
      movedFar = false;
      return;
    }
    const target = pick(event.offsetX, event.offsetY, tierWeights());
    if (!target || target.kind !== "node") return;
    if (target.tier === "country") {
      zoomToCountry(target.index);
    } else if (target.tier === "continent") {
      state.region = state.region === target.index ? -1 : target.index;
      syncToolbar();
      aggregate();
    }
  });

  canvas.addEventListener("keydown", event => {
    const { key } = event;
    if (key === "Enter") {
      const target = pick(W / 2, H / 2, tierWeights());
      if (target && target.kind === "node" && target.tier === "country") {
        event.preventDefault();
        zoomToCountry(target.index);
      }
      return;
    }
    if (key === "+" || key === "=") zoomBy(1.3, W / 2, H / 2);
    else if (key === "-" || key === "_") zoomBy(1 / 1.3, W / 2, H / 2);
    else if (key.startsWith("Arrow")) {
      const step = 60 / cam.scale;
      if (key === "ArrowLeft") cam.lon -= step;
      if (key === "ArrowRight") cam.lon += step;
      if (key === "ArrowUp") cam.lat += step;
      if (key === "ArrowDown") cam.lat -= step;
      clampCamera();
    } else return;
    event.preventDefault();
    manualCamera();
    baseDirty = true;
    render();
  });

  for (const id of ["zoom-in", "zoom-out"]) {
    document.getElementById(id).addEventListener("click", () => {
      zoomBy(id === "zoom-in" ? 1.35 : 1 / 1.35, W / 2, H / 2);
      manualCamera();
      baseDirty = true;
      render();
    });
  }
  document.getElementById("reset").addEventListener("click", () => {
    // 复位 = 回到打开页面时的初始状态：视图、月份、日期、聚焦、筛选全部清空。
    state.focus = -1;
    state.region = -1;
    state.month = 0;
    state.day = 0;
    state.view = "flat";
    view.target = 0;
    view.t = 0;
    document.querySelectorAll("[data-view]").forEach(el =>
      el.setAttribute("aria-pressed", el.dataset.view === "flat"));
    window.history.replaceState(null, "", location.pathname.split("/").pop());
    syncToolbar();
    aggregate();
    flyTo("world");
  });

  document.querySelector(".map-toolbar").addEventListener("click", event => {
    const monthButton = event.target.closest("[data-month]");
    if (monthButton) {
      state.month = Number(monthButton.dataset.month);
      state.day = 0;
      syncToolbar();
      aggregate();
      return;
    }
    const windowButton = event.target.closest("[data-window]");
    if (windowButton) {
      state.window = windowButton.dataset.window;
      syncToolbar();
      aggregate();
      return;
    }
    const cameraButton = event.target.closest("[data-camera]");
    if (cameraButton) {
      flyTo(cameraButton.dataset.camera);
      return;
    }
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      state.view = viewButton.dataset.view;
      view.target = state.view === "globe" ? 1 : 0;
      document.querySelectorAll("[data-view]").forEach(el =>
        el.setAttribute("aria-pressed", el.dataset.view === state.view));
      return;
    }
    const regionButton = event.target.closest("[data-region]");
    if (regionButton) {
      const index = Number(regionButton.dataset.region);
      state.region = state.region === index ? -1 : index;
      syncToolbar();
      aggregate();
    }
  });

  document.getElementById("region-bars").addEventListener("click", event => {
    const button = event.target.closest("[data-region]");
    if (!button) return;
    const index = Number(button.dataset.region);
    state.region = state.region === index ? -1 : index;
    syncToolbar();
    aggregate();
  });

  document.getElementById("calendar").addEventListener("click", event => {
    if (event.target.closest("[data-cal-toggle]")) {
      calendarOpen = !calendarOpen;
      renderCalendar();
      return;
    }
    const nav = event.target.closest("[data-cal-nav]");
    if (nav) {
      const next = state.month + Number(nav.dataset.calNav);
      if (next >= 0 && next < MONTHS.length) {
        state.month = next;
        state.day = 0;
        syncToolbar();
        aggregate();
      }
      return;
    }
    const cell = event.target.closest("[data-cal]");
    if (!cell || cell.disabled) return;
    state.day = Number(cell.dataset.cal);
    aggregate();
  });

  document.getElementById("days").addEventListener("click", event => {
    const button = event.target.closest("[data-day]");
    if (!button) return;
    state.day = Number(button.dataset.day);
    aggregate();
  });

  const playButton = document.getElementById("play");
  let timer = null;
  function setPlaying(playing) {
    state.playing = playing;
    playButton.setAttribute("aria-pressed", String(playing));
    playButton.innerHTML = playing ? '<span aria-hidden="true">❚❚</span> 暂停' : '<span aria-hidden="true">▶</span> 播放';
    if (playing) {
      timer = window.setInterval(() => {
        const month = MONTHS[state.month];
        state.day = (state.day + 1) % month.days;
        aggregate();
      }, 900);
    } else if (timer) {
      window.clearInterval(timer);
      timer = null;
    }
  }
  playButton.addEventListener("click", () => setPlaying(!state.playing));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.playing) setPlaying(false);
  });

  // ---- boot ---------------------------------------------------------------
  document.getElementById("region-filter").innerHTML =
    `<button type="button" data-region="-1" aria-pressed="true">全部</button>` +
    CONTINENTS.map((continent, index) =>
      `<button type="button" data-region="${index}" aria-pressed="false">${continent.name}</button>`).join("");

  const params = new URLSearchParams(window.location?.search || "");
  const wantedMonth = Number(params.get("month"));
  if (wantedMonth >= 1 && wantedMonth <= MONTHS.length) state.month = wantedMonth - 1;
  const wantedDay = Number(params.get("day"));
  if (wantedDay >= 1 && wantedDay <= MONTHS[state.month].days) state.day = wantedDay - 1;
  const wantedCamera = params.get("camera");
  if (["world", "europe", "america", "asia"].includes(wantedCamera)) state.camera = wantedCamera;
  const wantedCountry = params.get("country");
  if (wantedCountry) {
    const index = COUNTRIES.findIndex(country => country.code === wantedCountry);
    if (index >= 0) state.focus = index;
  }
  const wantedScale = params.has("scale") ? Number(params.get("scale")) : 0;
  const wantedLon = params.has("lon") ? Number(params.get("lon")) : NaN;
  const wantedLat = params.has("lat") ? Number(params.get("lat")) : NaN;

  resize();
  clampCamera();
  aggregate();
  syncToolbar();
  if (wantedScale > 0) {
    state.camera = "";
    cam.scale = wantedScale;
    if (Number.isFinite(wantedLon)) cam.lon = wantedLon;
    if (Number.isFinite(wantedLat)) cam.lat = wantedLat;
    clampCamera();
    baseDirty = true;
    render();
    syncToolbar();
  } else {
    flyTo(state.camera);
  }
  requestAnimationFrame(frame);

  if ("ResizeObserver" in window) {
    new ResizeObserver(() => { resize(); render(); }).observe(stage);
  } else {
    window.addEventListener("resize", () => { resize(); render(); });
  }
})();
