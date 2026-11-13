import { describe, expect, test } from "bun:test";
import type { Box, Point } from "../src/shared/model.ts";
import { routeArrow, type RouteEnd, type RouteOptions } from "../src/shared/route.ts";

const end = (x: number, y: number, w = 100, h = 50): RouteEnd => ({ box: { x, y, w, h }, point: [x + w / 2, y + h / 2], shape: "rect" });
const free = (x: number, y: number): RouteEnd => ({ box: null, point: [x, y], shape: "" });

const A = end(0, 0);
const RIGHT = end(300, 0);
const BELOW_RIGHT = end(300, 200);

describe("まっすぐな矢印は、縁から縁へ引く", () => {
  test.each<[string, RouteEnd, RouteEnd, RouteOptions, Point[]]>([
    ["横に並んだ箱は、向かい合う縁を結ぶ", A, RIGHT, {}, [[105, 25], [295, 25]]],
    ["辺を書いたら、その辺の真ん中を結ぶ", A, RIGHT, { fromSide: "bottom", toSide: "top" }, [[50, 55], [350, -5]]],
    ["片方だけ辺を書いたら、もう片方はその点へ向かう縁から出る", A, RIGHT, { fromSide: "top" }, [[50, -5], [295, 19.5]]],
    ["どこにも付かない端は、その点から出る", free(10, 10), RIGHT, {}, [[10, 10], [295, 22.57]]],
  ])("%s", (_name, a, b, opts, expected) => {
    const got = routeArrow(a, b, opts, []).map((p): Point => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
    expect(got).toEqual(expected);
  });
});

describe("折れ目を書いた折れ線は、出る向きから順に、横・縦と折れる", () => {
  test.each<[string, RouteOptions, Point[]]>([
    ["右へ出て x=200 で折れ、左の辺に入る", { fromSide: "right", bends: [200] }, [[105, 25], [200, 25], [200, 225], [295, 225]]],
    ["下へ出て y=120 で折れ、上の辺に入る", { fromSide: "bottom", bends: [120] }, [[50, 55], [50, 120], [350, 120], [350, 195]]],
    ["折れ目 2 つ。右へ、下へ、右へ進んで、上の辺に入る", { fromSide: "right", bends: [200, 100] }, [[105, 25], [200, 25], [200, 100], [350, 100], [350, 195]]],
    ["入る辺を書いたら、その辺に正面から入るよう、外で余分に曲がる", { fromSide: "right", bends: [200], toSide: "top" }, [[105, 25], [200, 25], [200, 177], [350, 177], [350, 195]]],
  ])("%s", (_name, opts, expected) => {
    expect(routeArrow(A, BELOW_RIGHT, { route: "elbow", ...opts }, [])).toEqual(expected);
  });
});

describe("折れ目を書かない折れ線は、直角に折れて、ほかの箱をよける", () => {
  const hits = (points: Point[], box: Box): boolean =>
    points.slice(1).some((b, i) => {
      const a = points[i] ?? b;
      return Math.min(a[0], b[0]) < box.x + box.w && Math.max(a[0], b[0]) > box.x && Math.min(a[1], b[1]) < box.y + box.h && Math.max(a[1], b[1]) > box.y;
    });
  const orthogonal = (points: Point[]): boolean => points.slice(1).every((b, i) => points[i]?.[0] === b[0] || points[i]?.[1] === b[1]);
  const WALL: Box = { x: 180, y: -40, w: 40, h: 130 };
  const BETWEEN: Box = { x: 150, y: 80, w: 100, h: 60 };

  test.each<[string, RouteEnd, RouteEnd, RouteOptions, Box[], number]>([
    ["横に並んだ箱は、曲がらずに結ぶ", A, RIGHT, {}, [], 2],
    ["斜めの位置の箱は、1 回曲がって結ぶ", A, BELOW_RIGHT, {}, [], 3],
    ["間に箱があれば、よけて回る", A, RIGHT, {}, [WALL], 4],
    ["1 回曲がる道に箱があれば、別の辺から出てよける", A, BELOW_RIGHT, {}, [BETWEEN, { x: 300, y: 80, w: 100, h: 60 }], 3],
    ["出る辺を書いたら、その辺から出る", A, BELOW_RIGHT, { fromSide: "bottom" }, [], 3],
  ])("%s", (_name, a, b, opts, boxes, count) => {
    const points = routeArrow(a, b, { route: "elbow", ...opts }, boxes);
    expect(orthogonal(points)).toBe(true);
    expect(boxes.filter((box) => hits(points, box))).toEqual([]);
    expect(points).toHaveLength(count);
    if (opts.fromSide === "bottom") expect(points[0]).toEqual([50, 55]);
  });
});
