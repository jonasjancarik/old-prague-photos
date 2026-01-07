(() => {
  function buildZoomifyTiers(width, height, tileSize) {
    const tiers = [];
    let w = width;
    let h = height;
    while (w > tileSize || h > tileSize) {
      tiers.push([w, h]);
      w = Math.floor((w + 1) / 2);
      h = Math.floor((h + 1) / 2);
    }
    tiers.push([w, h]);
    tiers.reverse(); // nejmenší -> největší
    return tiers;
  }

  function zoomifyTilesFor([w, h], tileSize) {
    return [Math.ceil(w / tileSize), Math.ceil(h / tileSize)];
  }

  function zoomifyTileGroupIndex(tiers, tileSize, level, x, y) {
    let offset = 0;
    for (let i = 0; i < level; i += 1) {
      const [tilesX, tilesY] = zoomifyTilesFor(tiers[i], tileSize);
      offset += tilesX * tilesY;
    }
    const [tilesX] = zoomifyTilesFor(tiers[level], tileSize);
    return Math.floor((offset + y * tilesX + x) / 256);
  }

  function createTileSource(meta) {
    if (!window.OpenSeadragon) throw new Error("OpenSeadragon chybí");
    const base = String(meta?.zoomifyImgPath || "").replace(/\/$/, "");
    const width = Number(meta?.width);
    const height = Number(meta?.height);
    const tileSize = Number(meta?.tileSize || 256);

    if (!base) throw new Error("Chybí zoomifyImgPath");
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error("Chybí rozměry");
    }
    if (!Number.isFinite(tileSize) || tileSize <= 0) {
      throw new Error("Chybí tileSize");
    }

    const tiers = buildZoomifyTiers(width, height, tileSize);
    const maxLevel = tiers.length - 1;

    return new window.OpenSeadragon.TileSource({
      width,
      height,
      tileSize,
      tileOverlap: 0,
      minLevel: 0,
      maxLevel,
      getNumTiles(level) {
        const tier = tiers[level];
        if (!tier) return new window.OpenSeadragon.Point(1, 1);
        const [tilesX, tilesY] = zoomifyTilesFor(tier, tileSize);
        return new window.OpenSeadragon.Point(tilesX, tilesY);
      },
      getLevelScale(level) {
        const tier = tiers[level];
        if (!tier) return 1;
        return tier[0] / width;
      },
      getTileUrl(level, x, y) {
        const group = zoomifyTileGroupIndex(tiers, tileSize, level, x, y);
        return `${base}/TileGroup${group}/${level}-${x}-${y}.jpg`;
      },
    });
  }

  window.OldPragueZoomify = {
    createTileSource,
  };
})();

