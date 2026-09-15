/**
 * Progressively-widened boot state, threaded by value through daemon.ts's
 * main(). Each extracted phase is typed via Pick<BootContext, ...> on its
 * input and output — an at-a-glance, enforced list of exactly what it reads
 * and produces — and main() merges each phase's return into this object via
 * Object.assign. Grows one field group per phase as main() is decomposed
 * (Sprint 28c, issue #33); this file has no fields yet since the first
 * extracted phase (log tee) needs none.
 */
export type BootContext = Record<string, never>;
