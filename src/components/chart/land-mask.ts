/**
 * A land/sea bitmask, so a globe with twenty points still reads as a planet.
 *
 * The globe used to carry no basemap, on the reasoning that "at that density
 * the nodes draw the continents themselves". That is true of Bitcoin's 3,293
 * coordinates and false of every other chain: Hedera's 20 and Monad's 59 read
 * as dots scattered on a wireframe, with nothing to say whether a cluster sits
 * in Virginia or in the middle of the Atlantic. This is the correction.
 *
 * ## Why a bitmask and not a coastline
 *
 * Shipping vectors means 55 KB of TopoJSON plus an arc decoder, or 138 KB of
 * GeoJSON, to draw a line the design wants recessive anyway. Rasterising the
 * same source onto a two-degree grid costs **2,025 bytes** — one bit per cell,
 * 180 by 90 — and gives a stippled landmass rather than an outline, which suits
 * a point cloud better than a border would: it reads as texture behind the data
 * instead of a second set of lines competing with it.
 *
 * 5,402 of the 16,200 cells are land. Measured at other resolutions while
 * planning: three degrees gives 2,398 dots and looks sparse, 1.5 degrees gives
 * 9,545 and starts to read as a solid fill.
 *
 * ## Provenance, and how to regenerate it
 *
 * Natural Earth `ne_110m_land` (public domain, no attribution required), outer
 * rings only — lakes are below the resolution of a two-degree grid. Generated
 * once, offline, and committed: there is no build step and nothing is fetched
 * at runtime.
 *
 * ```python
 * import json, base64
 * STEP = 2.0
 * COLS, ROWS = int(360 / STEP), int(180 / STEP)
 * # raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson
 * rings = []
 * for f in json.load(open("land.geojson"))["features"]:
 *     g = f["geometry"]
 *     polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
 *     rings += [poly[0] for poly in polys]
 *
 * def inside(x, y, ring):                      # ray casting
 *     c = False
 *     for i in range(len(ring)):
 *         x1, y1 = ring[i]; x2, y2 = ring[(i + 1) % len(ring)]
 *         if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
 *             c = not c
 *     return c
 *
 * bits = bytearray((COLS * ROWS + 7) // 8)
 * for j in range(ROWS):
 *     lat = 90 - (j + 0.5) * STEP
 *     for i in range(COLS):
 *         lon = -180 + (i + 0.5) * STEP
 *         if any(inside(lon, lat, r) for r in rings):
 *             k = j * COLS + i
 *             bits[k >> 3] |= 1 << (k & 7)     # LSB first within each byte
 * print(base64.b64encode(bytes(bits)).decode())
 * ```
 */

/** Degrees per cell. */
const STEP = 2;
const COLS = 360 / STEP;
const ROWS = 180 / STEP;

const MASK_BASE64 =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAfAP8DAAAAAAAAAAAAAAAAAAAAAADo//z//wcAAAAAAAACAAAAAAAAAAAAhvvw//8PAPABAAAAwAMAAAAAAAAAwADkw////wEABAAAAABgAAAAAAAAAADAUT8A/v8PAAAAAAwA/j8AuAEAAAAAcBHtDcD/fwAAAAAwAPz/fwMAABCAAQD5w/wD8P8FAAAMAIL7//9//xOAAP/ff0668QD/HwAA+A8At///////v3/w/////x8++B8AAOD/1//7////////jP////+/+AE/gAcAn9f//////////w/w/////wEs4AEAAHz+////////////gL////8HeAAcAADg5///////////9ADgAf7/f4AnAAAAAH78////////H0QAAAiA//8f8AcAAIBB4////////38ADwAQAOD//5//AQAAHAT/////////A3AAAAAA/v//+T8AAGDz//////////8DAQAAAMD/////AwAAsP//////////LwAAAAAA6P///2IAAAD+//////////8CAAAAAAD///8/CAAA4P//////////JwAAAAAA8P///wYAAAD+/un//////z8AAAAAAAD///8HAAAA/pgP/P//////MQAAAAAA8P//PwAAAMBD9v7//////wcBAAAAAAD///8AAAAAPkD7//////8hEAAAAAAA4P//DwAAAIDhAv//////f8YAAAAAAAD8//8AAAAA+AdE//////8jDwAAAAAAgP//AwAAAMD/APD/////PxgAAAAAAADw/x8AAAAA/n/v//////8HAAAAAAAAAPwDAgAAAOD////7////fwAAAAAAAACgHyAAAACA//9/f/7///8DAAAAAAAAAPQBAAAAAPj//+cv+P//PwAAAAAAAAAAHjAAAADA/////g/+//8EAAAAAAAAAOBhCAAAAP7//99/4D//AAAAAAAAAAAAPAMEAADA////+Qf84BcAAAAAAAAAAAA/AAAAAPz//58fgAf+QAAAAAAAAAAAAA8AAADg////ewA4gA8EAAAAAAAAAADAAAAAAPz//38BgAP4QQAAAAAAAAAAAAgPAADA////zwAwgAwQAAAAAAAAAAAA9Q8AAPj///8HAAVIAAAAAAAAAAAAAID/AQAA////fwBAAAAQAAAAAAAAAAAA+P8AAGDh//8DAAA0GAAAAAAAAAAAAID/HwAAAPj/HwAAgMIBAAAAAAAAAAAA/P8BAACA//8AAAAYXgAAAAAAAAAAAMD/fwAAAPz/BwAAAOOBAQAAAAAAAAAA/P8/AACA/z8AAABgbtQBAAAAAAAAAOD//w8AAPD/AwAAAAQIeAAAAAAAAAAA/P//AQAA/z8AAACAA4APAQAAAAAAAID//w8AAPD/AwAAAAARsEAAAAAAAAAA+P9/AAAA/j8AAAAAAAAAAAAAAAAAAAD//wcAAPD/QwAAAACAIwAAAAAAAAAA8P9/AAAA/z8EAAAAAD8GIAAAAAAAAAD8/wMAAPD/cQAAAAD4ZwAAAAAAAAAAgP8/AAAA/w8HAAAAgP8HAAAAAAAAAAD4/wMAAOD/MAAAAAD//wEBAAAAAAAAgP8PAAAA/g8DAAAA+P8fAAAAAAAAAAD4PwAAAOB/EAAAAID//wMAAAAAAAAAgP8DAAAA/AMAAAAA+P9/AAAAAAAAAAD8HwAAAMA/AAAAAID//wcAAAAAAAAAwP8BAAAA+AEAAAAA8P9/AAAAAAAAAAD8DwAAAIAPAAAAAAAP/gMAAAAAAAAAwB8AAAAAAAAAAAAAEIAfAAEAAAAAAAD+AwAAAAAAAAAAAAAA8AEgAAAAAAAA4AcAAAAAAAAAAAAAAAAAAAYAAAAAAABeAAAAAAAAAAAAAAAAwAAwAAAAAAAAwAMAAAAAAAAAAAAAAAAIgAEAAAAAAAAeAAAAAAAAAAAAAAAAAAAMAAAAAAAA4AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAAAAAAAAAAABAAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAB4AEDwn/8HAAAAAAAAAAAwAAAAAACA/P/h/////w8AAAAAAAAAwAcAAAD4////z///////PwAAAAAAHALwAACA//////////////8HAADw/y///wMAAP7/////////////HwAA+P///38AAID///////////////8AAPL/////BwAO////////////////DwAA8P////8HEPD//////////////z8AAOD/////////////////////////H/AfwP//////////////////////////////////////////////////////////////////////////////////////";

/**
 * The centre of every land cell.
 *
 * Built once at module scope by the caller, which feeds it through the same
 * `buildPointCache` the nodes use — so the basemap costs one extra
 * `projectInto` per frame and no trigonometry of its own.
 */
export function landPoints(): { lat: number; lon: number }[] {
  const binary = atob(MASK_BASE64);
  const points: { lat: number; lon: number }[] = [];

  for (let j = 0; j < ROWS; j++) {
    const lat = 90 - (j + 0.5) * STEP;
    for (let i = 0; i < COLS; i++) {
      const k = j * COLS + i;
      if ((binary.charCodeAt(k >> 3) >> (k & 7)) & 1) {
        points.push({ lat, lon: -180 + (i + 0.5) * STEP });
      }
    }
  }

  return points;
}
