/**
 * Minimal ambient declarations for the two build-time layout libraries (no @types packages are installed:
 * the M2 plan allows adding only d3-force@3.0.1 and d3-hierarchy@3.1.3). Only what the figures module uses.
 */
declare module "d3-force" {
  export interface SimulationNodeDatum {
    index?: number;
    x?: number;
    y?: number;
    vx?: number;
    vy?: number;
    fx?: number | null;
    fy?: number | null;
  }
  export interface SimulationLinkDatum<N> {
    source: string | N;
    target: string | N;
  }
  export type Force = ((alpha: number) => void) & { initialize?: (nodes: unknown[], random: () => number) => void };
  export interface Simulation<N> {
    force(name: string, force: unknown): this;
    tick(iterations?: number): this;
    stop(): this;
    randomSource(source: () => number): this;
    alpha(alpha: number): this;
    alphaMin(min: number): this;
    alphaDecay(decay: number): this;
    velocityDecay(decay: number): this;
    nodes(): N[];
  }
  export interface LinkForce<N> {
    id(fn: (d: N) => string): this;
    distance(d: number | ((l: unknown) => number)): this;
    strength(s: number | ((l: unknown) => number)): this;
    iterations(n: number): this;
  }
  export interface ManyBodyForce {
    strength(s: number): this;
    distanceMax(d: number): this;
    theta(t: number): this;
  }
  export interface PositionForce {
    strength(s: number | ((d: unknown) => number)): this;
  }
  export function forceSimulation<N extends SimulationNodeDatum>(nodes?: N[]): Simulation<N>;
  export function forceLink<N, L>(links?: L[]): LinkForce<N>;
  export function forceManyBody(): ManyBodyForce;
  export function forceX(x?: number | ((d: never) => number)): PositionForce;
  export function forceY(y?: number | ((d: never) => number)): PositionForce;
}

declare module "d3-hierarchy" {
  export interface HierarchyPointNode<T> {
    data: T;
    depth: number;
    height: number;
    x: number;
    y: number;
    parent: HierarchyPointNode<T> | null;
    children?: HierarchyPointNode<T>[];
    descendants(): HierarchyPointNode<T>[];
    links(): { source: HierarchyPointNode<T>; target: HierarchyPointNode<T> }[];
  }
  export interface HierarchyNode<T> {
    data: T;
    depth: number;
  }
  export interface TreeLayout<T> {
    (root: HierarchyNode<T>): HierarchyPointNode<T>;
    nodeSize(size: [number, number]): this;
    separation(fn: (a: HierarchyPointNode<T>, b: HierarchyPointNode<T>) => number): this;
  }
  export function hierarchy<T>(data: T, children?: (d: T) => T[] | null | undefined): HierarchyNode<T>;
  export function tree<T>(): TreeLayout<T>;
}
